import { EntityManager } from '@mikro-orm/sqlite';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictException } from '@packages/common';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import { mintToken } from '../../../auth/mint-token';
import { RUNTIME_TOKEN, type RuntimeInfo } from '../../../auth/runtime';
import type {
  AgentEvent,
  AgentTurnHandle,
} from '../../agents/adapters/adapter.types';
import type { AgentAdapter } from '../../agents/adapters/agent-adapter';
import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import { CursorAdapter } from '../../agents/adapters/cursor/cursor.adapter';
import type { ItemWire, RunWire } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import { ProcessRegistry } from '../../agents/services/process-registry';
import {
  mapEventToItem,
  terminalStatus,
} from '../../agents/utils/event-to-item';
import { persistItemAndEmit, runToWire } from '../../agents/utils/persist-item';
import { resolveValidCwd } from '../../agents/utils/resolve-cwd';
import { assertWorkflowRun } from '../../agents/utils/run-kind';
import { createSessionIdSaver } from '../../agents/utils/session-saver';
import type { ItemKind } from '../../runs/runs.types';
import type {
  CalleeTurnOutcome,
  NodeStateWire,
  Workflow,
  WorkflowAgentNode,
  WorkflowNode,
} from '../graphs.types';
import {
  buildEdgeMaps,
  computeRunOrder,
  onDemandNodeIds,
} from '../utils/graph-order';
import {
  validateRunnableGraph,
  validateWorkflowGraph,
} from '../utils/graph-validate';
import { flattenRole } from '../utils/role-text';
import { createTurnSemaphore } from '../utils/turn-semaphore';
import { CallBroker } from './call-broker.service';

/** How one node's turn ended (the run-level rollup derives from these). */
type NodeOutcome = 'completed' | 'failed' | 'cancelled' | 'skipped';

/**
 * Max CLI agent processes one workflow run drives at once. A wide DAG level
 * would otherwise spawn every ready node simultaneously — N full CLI agents on
 * one machine. Ready nodes beyond the cap stay queued; each settling node
 * re-enters schedule(), which launches them as slots free up.
 */
const MAX_PARALLEL_NODES = 4;

/**
 * Max concurrent callee sub-turns per run — a pool SEPARATE from
 * `MAX_PARALLEL_NODES`: a sync caller keeps its node slot while blocked on
 * its callee, so sharing one pool would deadlock a full level of sync
 * callers (four callers holding four slots, zero left for their callees).
 */
const MAX_PARALLEL_SUB_TURNS = 4;

export interface StartWorkflowRunInput {
  /** Library slug — persisted as `Run.workflowId`. */
  slug: string;
  workflow: Workflow;
  /** Shared working folder every node runs in. */
  cwd: string;
  /** The user's task — seeds every node's prompt. */
  prompt: string;
}

/**
 * The DAG fan-out executor: runs a workflow's agent nodes in topological
 * order, independent nodes in parallel, each node's final text feeding its
 * consumers' prompts (plus the shared cwd where their edits land). Reuses the
 * whole M2 execution substrate — the adapters, `ProcessRegistry` (via one
 * aggregate handle per run, so cancel/shutdown reaps every live CLI group),
 * and persist-then-emit ordering: all of a run's writes serialize through one
 * promise chain, so `seq` stays monotonic even while N nodes stream at once.
 * Failure semantics: a failed/cancelled node skips its downstream consumers;
 * independent branches keep running; the run rolls up to
 * completed / failed / cancelled once every node settles.
 */
@Injectable()
export class GraphExecutorService {
  private readonly logger = new Logger(GraphExecutorService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly bus: AgentEventBus,
    private readonly registry: ProcessRegistry,
    private readonly approvals: ApprovalRegistry,
    private readonly claude: ClaudeAdapter,
    private readonly cursor: CursorAdapter,
    private readonly callTokens: CallTokenRegistry,
    private readonly callBroker: CallBroker,
    @Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo,
  ) {}

  /**
   * Create the run + pending node states, persist the seed message, kick off
   * the DAG walk, and return immediately — the transcript streams over the
   * bus → WS while the graph executes.
   */
  async startRun(input: StartWorkflowRunInput): Promise<RunWire> {
    validateWorkflowGraph(input.workflow.nodes, input.workflow.edges);
    validateRunnableGraph(input.workflow.nodes, input.workflow.edges);
    computeRunOrder(input.workflow.nodes, input.workflow.edges);
    const cwd = resolveValidCwd(input.cwd);

    const em = this.em.fork();
    const run = await this.runDao.create(
      {
        workflowId: input.slug,
        status: 'running',
        agentKind: null,
        cwd,
        model: null,
        title: input.workflow.name,
      },
      em,
    );
    if (!this.registry.tryClaim(run.id)) {
      throw new ConflictException('RUN_BUSY', 'run is already executing');
    }
    // Call tokens are minted per caller node inside drive() (once the call
    // edges are known); nothing to revoke here yet — the catch keeps the
    // revokeRun call for symmetry with the settle path.
    try {
      for (const node of input.workflow.nodes) {
        await this.nodeStateDao.createPending(run.id, node.id, em);
      }
    } catch (err) {
      // Failed before drive() registered the aggregate handle — drop the claim
      // and any call tokens, and close the run so it is not wedged as
      // permanently busy/running (mirror of the chat turn's pre-handle catch).
      this.registry.release(run.id);
      this.callTokens.revokeRun(run.id);
      await this.runDao
        .updateById(run.id, { status: 'failed' }, em)
        .catch(() => {});
      throw err;
    }

    this.drive(em, run.id, input.workflow, cwd, input.prompt);

    return runToWire(run);
  }

  async cancel(runId: string): Promise<{ cancelled: boolean }> {
    const em = this.em.fork();
    // Kind-guarded mirror of ChatService.cancel (shared assert — the two
    // cancels converge on one registry key) + the 404 the chat siblings return.
    assertWorkflowRun(await this.runDao.getById(runId, em), runId);
    return { cancelled: this.registry.cancel(runId) };
  }

  /** Workflow runs, newest first (the Chats page's run picker). */
  async listRuns(): Promise<RunWire[]> {
    const em = this.em.fork();
    const runs = await this.runDao.listWorkflowRuns(em);
    return runs.map(runToWire);
  }

  /** Per-node execution states of one run (node chips + reconnect snapshot). */
  async getNodeStates(runId: string): Promise<NodeStateWire[]> {
    const em = this.em.fork();
    assertWorkflowRun(await this.runDao.getById(runId, em), runId);
    const rows = await this.nodeStateDao.listByRun(runId, em);
    return rows.map((row) => ({
      runId: row.runId,
      nodeId: row.nodeId,
      status: row.status,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      error: row.error,
    }));
  }

  /**
   * Close workflow runs a crash / SIGKILL left non-terminal (mirror of the
   * chat service's boot reconcile — see its doc for why this is called from
   * `main.ts` after the schema sync). Stuck `running` nodes go `failed`,
   * never-started `pending` nodes go `skipped`, and the run rolls up `failed`.
   */
  async reconcileOrphanedRuns(): Promise<void> {
    try {
      const em = this.em.fork();
      const stale = await this.runDao.listRunningWorkflowRuns(em);
      let reconciled = 0;
      for (const run of stale) {
        if (this.registry.has(run.id)) {
          continue; // a live executor legitimately owns this run
        }
        const seq = (await this.itemDao.maxSeq(run.id, em)) + 1;
        await this.persist(em, run.id, null, seq, 'error', null, {
          message:
            'workflow run interrupted — the daemon stopped before it finished',
        });
        for (const node of await this.nodeStateDao.listByRun(run.id, em)) {
          if (node.status === 'running') {
            await this.nodeStateDao.setStatus(
              run.id,
              node.nodeId,
              { status: 'failed', endedAt: Date.now(), error: 'interrupted' },
              em,
            );
          } else if (node.status === 'pending') {
            await this.nodeStateDao.setStatus(
              run.id,
              node.nodeId,
              { status: 'skipped', endedAt: Date.now() },
              em,
            );
          }
        }
        await this.runDao.updateById(run.id, { status: 'failed' }, em);
        reconciled += 1;
      }
      if (reconciled > 0) {
        this.logger.warn(
          `reconciled ${reconciled} orphaned workflow run(s) to failed on boot`,
        );
      }
    } catch (err) {
      // Best-effort cleanup — never block daemon boot.
      this.logger.error(
        `boot reconcile of orphaned workflow runs failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** The DAG walk. Never throws — every failure becomes transcript + status. */
  private drive(
    em: EntityManager,
    runId: string,
    workflow: Workflow,
    cwd: string,
    seedPrompt: string,
  ): void {
    const nodes = workflow.nodes;
    const { producersOf } = buildEdgeMaps(nodes, workflow.edges);
    const nodesById = new Map(nodes.map((n) => [n.id, n]));
    // Call-only callees run per CallBroker call — never scheduled, never in
    // the settled denominator (an uncalled one settles 'skipped' at run end).
    const onDemand = onDemandNodeIds(nodes, workflow.edges);
    const dagNodes = nodes.filter((n) => !onDemand.has(n.id));
    // Caller → callee agent nodes, from the call edges. Drives the broker's
    // dispatch, each caller's MCP endpoint grant, and its awareness block.
    const calleesOf = new Map<string, WorkflowAgentNode[]>();
    for (const edge of workflow.edges) {
      if (edge.kind !== 'call') {
        continue;
      }
      const callee = nodesById.get(edge.to);
      if (callee?.kind !== 'agent') {
        continue;
      }
      const list = calleesOf.get(edge.from);
      if (list) {
        list.push(callee);
      } else {
        calleesOf.set(edge.from, [callee]);
      }
    }

    const finalTexts = new Map<string, string>();
    const settled = new Map<string, NodeOutcome>();
    const runningHandles = new Map<string, AgentTurnHandle>();
    // Callee sub-turns: cancel fans to these, but they never enter `settled`,
    // `runningHandles`, or the ProcessRegistry — they ride the aggregate
    // handle, and only `liveSubTurns` holds the run open for them.
    const subTurnHandles = new Map<string, AgentTurnHandle>();
    const subTurnSlots = createTurnSemaphore(MAX_PARALLEL_SUB_TURNS);
    let liveSubTurns = 0;
    const calleeTurnCounts = new Map<string, number>();
    // Live turns per node id — the approval sweep must wait for a node's LAST
    // turn (a callable DAG node can hold a DAG turn and callee turns at once).
    const liveTurnsByNode = new Map<string, number>();
    const retainNodeTurn = (nodeId: string): void => {
      liveTurnsByNode.set(nodeId, (liveTurnsByNode.get(nodeId) ?? 0) + 1);
    };
    const releaseNodeTurn = (nodeId: string): boolean => {
      const next = (liveTurnsByNode.get(nodeId) ?? 1) - 1;
      if (next <= 0) {
        liveTurnsByNode.delete(nodeId);
        return true;
      }
      liveTurnsByNode.set(nodeId, next);
      return false;
    };
    let cancelRequested = false;
    let seq = 0;
    let runFinished = false;

    // One serialized write chain for the whole run: seq allocation and
    // persist-then-emit ordering stay correct while N nodes stream at once.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (work: () => Promise<void> | void): void => {
      chain = chain.then(work).catch((err: unknown) => {
        this.logger.error(
          `workflow run ${runId} event handling failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    };

    const persistItem = (
      nodeId: string | null,
      kind: ItemKind,
      role: string | null,
      payload: unknown,
    ): Promise<ItemWire> =>
      this.persist(em, runId, nodeId, seq++, kind, role, payload);

    let resolveAllDone!: () => void;
    const allDone = new Promise<void>((resolve) => {
      resolveAllDone = resolve;
    });
    const aggregateHandle: AgentTurnHandle = {
      done: allDone,
      cancel: () => {
        if (cancelRequested) {
          return;
        }
        cancelRequested = true;
        for (const handle of runningHandles.values()) {
          handle.cancel();
        }
        for (const handle of subTurnHandles.values()) {
          handle.cancel();
        }
        // Nodes that never started settle as cancelled in the next pass.
        enqueue(() => schedule());
      },
      // Approvals route through the ApprovalRegistry per request, not the
      // aggregate — a run-level respond has no single target turn.
      respondApproval: () => false,
    };
    this.registry.register(runId, aggregateHandle);

    const finishRunIfSettled = async (): Promise<void> => {
      // Sub-turns stay OUT of the denominator, but a live one (a
      // fire-and-forget still streaming) holds the run open until it settles.
      if (runFinished || settled.size !== dagNodes.length || liveSubTurns > 0) {
        return;
      }
      runFinished = true;
      // EVERY final write is inside the try: the skipped-marking loop, the
      // status roll-up, and the run update must all sit under the finally, or
      // a SQLite failure in the skipped loop would leave runFinished true with
      // the aggregate handle never settling — the registry entry and call
      // token would leak and the run would wedge as `running` forever.
      try {
        // On-demand callees that were never called settle 'skipped' so their
        // chips don't read as pending forever.
        for (const node of nodes) {
          if (
            !onDemand.has(node.id) ||
            (calleeTurnCounts.get(node.id) ?? 0) > 0
          ) {
            continue;
          }
          await this.nodeStateDao.setStatus(
            runId,
            node.id,
            { status: 'skipped', endedAt: Date.now() },
            em,
          );
          await persistItem(node.id, 'status', null, {
            nodeId: node.id,
            status: 'skipped',
            reason: 'never called',
          });
        }
        // A user cancel rolls up cancelled; any other non-completed node (a
        // failure, or a CLI killed externally without cancel()) is a failure —
        // downstream nodes were skipped, so the run must never read as success.
        const anyNotCompleted = [...settled.values()].some(
          (outcome) => outcome !== 'completed',
        );
        const status = cancelRequested
          ? 'cancelled'
          : anyNotCompleted
            ? 'failed'
            : 'completed';
        await persistItem(null, 'turn_complete', null, {
          usage: null,
          stopReason: `workflow_${status}`,
        });
        await this.runDao.updateById(runId, { status }, em);
      } finally {
        // The aggregate handle MUST settle even if the final writes fail, or
        // the ProcessRegistry entry leaks and the run can never be re-driven.
        // The call surface dies with the run — broker state dropped, every
        // caller-node token revoked, so a child that outlived its run can't
        // reopen its MCP endpoint.
        this.callBroker.unregisterRun(runId);
        this.callTokens.revokeRun(runId);
        resolveAllDone();
      }
    };

    /**
     * A trigger node runs no CLI — firing it IS the run start, so it settles
     * completed instantly (its downstream agents launch in the same schedule
     * pass). It records no finalText: the seed prompt already reaches every
     * agent, so composePrompt must not add an empty "output from trigger"
     * section.
     */
    const fireTrigger = (node: WorkflowNode): void => {
      settled.set(node.id, 'completed');
      enqueue(async () => {
        const now = Date.now();
        await this.nodeStateDao.setStatus(
          runId,
          node.id,
          { status: 'completed', startedAt: now, endedAt: now },
          em,
        );
        await persistItem(node.id, 'status', null, {
          nodeId: node.id,
          status: 'completed',
        });
      });
    };

    /**
     * The node's "turn is starting" bookkeeping shared by DAG launches and
     * callee sub-turns: node_state → running, the status item, and the
     * cursor ask→auto degrade note.
     */
    const persistTurnStart = (node: WorkflowAgentNode): void => {
      enqueue(async () => {
        await this.nodeStateDao.setStatus(
          runId,
          node.id,
          { status: 'running', startedAt: Date.now() },
          em,
        );
        await persistItem(node.id, 'status', null, {
          nodeId: node.id,
          status: 'running',
        });
        if (node.agent === 'cursor-agent' && node.approval === 'ask') {
          await persistItem(node.id, 'system', null, {
            message:
              "cursor-agent has no approval callback — node approval 'ask' degrades to auto-approve for this node",
          });
        }
      });
    };

    /**
     * The caller's MCP grant: only claude nodes with outgoing call edges get
     * the endpoint (cursor callers land in milestone 3 — their callees still
     * work, THEY just can't call). Null when the server has no bound port
     * yet or the run's token is already revoked.
     */
    const mcpEndpointFor = (
      node: WorkflowAgentNode,
    ): { url: string; token: string } | null => {
      if (node.agent !== 'claude' || !calleesOf.has(node.id)) {
        return null;
      }
      const token = this.callTokens.get(runId, node.id);
      const port = this.runtime.port;
      if (token === null || port === null) {
        return null;
      }
      return {
        url: `http://127.0.0.1:${port}/v1/mcp/${encodeURIComponent(runId)}/${encodeURIComponent(node.id)}`,
        token,
      };
    };

    /**
     * The caller's system prompt: its role plus a "May call" block naming
     * each callee (id + one-line role) so the agent knows who its call_agent
     * tool reaches. Non-callers keep their bare role.
     */
    const systemPromptFor = (node: WorkflowAgentNode): string | null => {
      const callees = calleesOf.get(node.id);
      if (!callees || node.agent !== 'claude') {
        return node.role ?? null;
      }
      const lines = callees.map((callee) => {
        const name = callee.name ?? callee.id;
        const role = flattenRole(callee.role, 200);
        return `- ${name} (agent id: ${callee.id})${role ? ` — ${role}` : ''}`;
      });
      const block = `May call (via the call_agent tool; await_agent collects async results):\n${lines.join('\n')}`;
      return node.role ? `${node.role}\n\n${block}` : block;
    };

    /**
     * Spawn one adapter turn for `node` and wire its event stream into the
     * transcript (session save, text/terminal capture, item persistence,
     * approval tracking). Shared by DAG launches and callee sub-turns — the
     * paths differ only in prompt source, handle registry, and settle
     * bookkeeping. `finish()` applies the synthetic-completion fallback (a
     * clean exit with no result line still completes) and is only meaningful
     * after `handle.done` AND the event chain drained — call it from an
     * enqueue()d continuation.
     */
    const beginAgentTurn = (
      node: WorkflowAgentNode,
      prompt: string,
    ): {
      handle: AgentTurnHandle;
      finish: () => { outcome: NodeOutcome; finalText: string | null };
    } => {
      const adapter: AgentAdapter =
        node.agent === 'claude' ? this.claude : this.cursor;
      const textChunks: string[] = [];
      let finalText: string | null = null;
      let outcome: NodeOutcome | null = null;

      const saveSessionId = createSessionIdSaver(
        this.nodeStateDao,
        runId,
        node.id,
        null,
        em,
      );
      const handle = adapter.start(
        {
          prompt,
          cwd,
          model: node.model ?? null,
          resumeSessionId: null,
          systemPrompt: systemPromptFor(node),
          approvalMode: node.approval,
          mcpEndpoint: mcpEndpointFor(node),
        },
        (event: AgentEvent) => {
          enqueue(async () => {
            if (event.type === 'session') {
              await saveSessionId(event.sessionId);
              return;
            }
            if (event.type === 'text') {
              textChunks.push(event.text);
            }
            if (event.type === 'turn_complete') {
              finalText = event.finalText ?? textChunks.join('');
            }
            const terminal = terminalStatus(event);
            if (
              terminal === 'completed' ||
              terminal === 'failed' ||
              terminal === 'cancelled'
            ) {
              outcome = terminal;
            }
            const mapped = mapEventToItem(event);
            if (mapped) {
              await persistItem(node.id, mapped.kind, mapped.role, {
                ...(mapped.payload as Record<string, unknown>),
                nodeId: node.id,
              });
            }
            if (event.type === 'approval_request') {
              this.approvals.track({
                runId,
                nodeId: node.id,
                requestId: event.id,
                toolName: event.toolName,
                input: event.input,
                respond: (allow) => {
                  const delivered = handle.respondApproval(
                    event.id,
                    allow,
                    event.input,
                  );
                  if (delivered) {
                    enqueue(async () => {
                      await persistItem(node.id, 'approval_verdict', null, {
                        id: event.id,
                        nodeId: node.id,
                        allow,
                      });
                    });
                  }
                  return delivered;
                },
              });
            }
          });
        },
      );

      const finish = (): { outcome: NodeOutcome; finalText: string | null } => {
        // A clean exit with no result line still completes the node — the
        // synthetic-completion mirror of the chat turn's finalizer.
        const finalOutcome: NodeOutcome =
          outcome ?? (cancelRequested ? 'cancelled' : 'completed');
        const text =
          finalOutcome === 'completed'
            ? (finalText ?? textChunks.join(''))
            : finalText;
        return { outcome: finalOutcome, finalText: text };
      };
      return { handle, finish };
    };

    const launchNode = (node: WorkflowAgentNode): void => {
      persistTurnStart(node);

      const prompt = this.composePrompt(
        seedPrompt,
        producersOf.get(node.id) ?? new Set(),
        nodesById,
        finalTexts,
      );
      retainNodeTurn(node.id);
      // A synchronous throw out of beginAgentTurn (e.g. prepareTurn's
      // config-file write fails) must settle THIS node as failed and keep the
      // DAG walking — drive()/startRun promise "never throws", and letting it
      // escape would leave the aggregate handle registered but never settling.
      let handle: AgentTurnHandle;
      let finish: () => { outcome: NodeOutcome; finalText: string | null };
      try {
        ({ handle, finish } = beginAgentTurn(node, prompt));
      } catch (err) {
        releaseNodeTurn(node.id);
        this.approvals.sweepNode(runId, node.id);
        settled.set(node.id, 'failed');
        enqueue(async () => {
          await this.nodeStateDao
            .setStatus(
              runId,
              node.id,
              {
                status: 'failed',
                endedAt: Date.now(),
                error: `turn start failed: ${err instanceof Error ? err.message : String(err)}`,
              },
              em,
            )
            .catch(() => {});
          await persistItem(node.id, 'status', null, {
            nodeId: node.id,
            status: 'failed',
          }).catch(() => {});
          schedule();
        });
        return;
      }
      runningHandles.set(node.id, handle);

      void handle.done.then(() => {
        enqueue(async () => {
          if (releaseNodeTurn(node.id)) {
            this.approvals.sweepNode(runId, node.id);
          }
          runningHandles.delete(node.id);
          const { outcome, finalText } = finish();
          settled.set(node.id, outcome);
          if (outcome === 'completed') {
            finalTexts.set(node.id, finalText ?? '');
          }
          try {
            await this.nodeStateDao.setStatus(
              runId,
              node.id,
              {
                status: outcome,
                endedAt: Date.now(),
                error: outcome === 'failed' ? 'node turn failed' : null,
              },
              em,
            );
            await persistItem(node.id, 'status', null, {
              nodeId: node.id,
              status: outcome,
            });
          } finally {
            // The DAG walk must continue even if this node's bookkeeping write
            // throws — schedule() is the only path that launches/skips the
            // downstream nodes and enqueues the run finalizer (always AFTER
            // any skip writes, so the run-level turn_complete stays last).
            schedule();
          }
        });
      });
    };

    const cancelledOutcome: CalleeTurnOutcome = {
      status: 'cancelled',
      finalText: null,
      error: 'run cancelled',
    };

    /**
     * One fresh callee turn per CallBroker call. Items stream under the
     * CALLEE's nodeId and the node_state row is upserted per call (the latest
     * call wins). Resolves only after the turn's bookkeeping drained through
     * the write chain — a sync caller's envelope must not outrun the items it
     * summarizes.
     *
     * Only depth-1 turns (a top-level caller's callee) draw from the sub-turn
     * slot pool: a nested (depth ≥ 2) sync caller holds a slot while blocked
     * on its own callee, so bounding deeper turns too would let a legal
     * fan-out hold every slot and deadlock the run. The depth cap (3) and the
     * per-run turn cap (50) bound the deeper turns instead.
     */
    const launchCalleeTurn = async (
      callee: WorkflowAgentNode,
      message: string,
      callId: string,
      depth: number,
    ): Promise<CalleeTurnOutcome> => {
      liveSubTurns += 1;
      try {
        // runFinished: a call arriving in the finalization window (the caller
        // CLI's POST still in flight after the run settled) must NOT spawn an
        // unmanaged child on a completed run — its ProcessRegistry entry is
        // already gone, so cancel/shutdown could never reach it.
        if (cancelRequested || runFinished) {
          return cancelledOutcome;
        }
        const releaseSlot = depth <= 1 ? await subTurnSlots.acquire() : null;
        try {
          if (cancelRequested || runFinished) {
            return cancelledOutcome;
          }
          calleeTurnCounts.set(
            callee.id,
            (calleeTurnCounts.get(callee.id) ?? 0) + 1,
          );
          retainNodeTurn(callee.id);
          // A synchronous throw out of beginAgentTurn (e.g. prepareTurn's
          // config-file write hits ENOSPC) must settle the turn as failed and
          // release the retained node turn — never leak the count (which would
          // suppress this node's approval sweep for the rest of the run) nor
          // reject into the broker with an unbalanced ledger.
          let handle: AgentTurnHandle;
          let finish: () => { outcome: NodeOutcome; finalText: string | null };
          try {
            persistTurnStart(callee);
            ({ handle, finish } = beginAgentTurn(callee, message));
          } catch (err) {
            if (releaseNodeTurn(callee.id)) {
              this.approvals.sweepNode(runId, callee.id);
            }
            enqueue(async () => {
              await this.nodeStateDao
                .setStatus(
                  runId,
                  callee.id,
                  {
                    status: 'failed',
                    endedAt: Date.now(),
                    error: 'turn start failed',
                  },
                  em,
                )
                .catch(() => {});
            });
            return {
              status: 'failed',
              finalText: null,
              error: `turn start failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
          subTurnHandles.set(callId, handle);
          await handle.done;
          return await new Promise<CalleeTurnOutcome>((resolve) => {
            enqueue(async () => {
              // Resolve in finally: a bookkeeping write failure must never
              // leave the broker's envelope pending (a sync caller would
              // hang and the run could never finish).
              let result: CalleeTurnOutcome = {
                status: 'failed',
                finalText: null,
                error: 'callee bookkeeping failed',
              };
              try {
                if (releaseNodeTurn(callee.id)) {
                  this.approvals.sweepNode(runId, callee.id);
                }
                subTurnHandles.delete(callId);
                const { outcome, finalText } = finish();
                const status =
                  outcome === 'completed'
                    ? 'completed'
                    : outcome === 'cancelled'
                      ? 'cancelled'
                      : 'failed';
                result = {
                  status,
                  finalText,
                  error: status === 'failed' ? 'callee turn failed' : null,
                };
                await this.nodeStateDao.setStatus(
                  runId,
                  callee.id,
                  {
                    status: outcome,
                    endedAt: Date.now(),
                    error: outcome === 'failed' ? 'node turn failed' : null,
                  },
                  em,
                );
                await persistItem(callee.id, 'status', null, {
                  nodeId: callee.id,
                  status: outcome,
                });
              } finally {
                resolve(result);
              }
            });
          });
        } finally {
          releaseSlot?.();
        }
      } finally {
        liveSubTurns -= 1;
        enqueue(() => finishRunIfSettled());
      }
    };

    /**
     * Launch every node whose producers all completed; settle nodes whose
     * producers can no longer complete. Loops until a pass changes nothing
     * (skips cascade down the graph in one call).
     */
    const schedule = (): void => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of dagNodes) {
          if (settled.has(node.id) || runningHandles.has(node.id)) {
            continue;
          }
          if (cancelRequested) {
            settled.set(node.id, 'cancelled');
            enqueue(async () => {
              await this.nodeStateDao.setStatus(
                runId,
                node.id,
                { status: 'cancelled', endedAt: Date.now() },
                em,
              );
              await persistItem(node.id, 'status', null, {
                nodeId: node.id,
                status: 'cancelled',
              });
            });
            changed = true;
            continue;
          }
          const producers = [...(producersOf.get(node.id) ?? [])];
          const allSettled = producers.every((id) => settled.has(id));
          if (!allSettled) {
            continue;
          }
          const allCompleted = producers.every(
            (id) => settled.get(id) === 'completed',
          );
          if (allCompleted) {
            if (node.kind === 'trigger') {
              // No process, no concurrency slot — settles in this pass.
              fireTrigger(node);
              changed = true;
              continue;
            }
            if (runningHandles.size >= MAX_PARALLEL_NODES) {
              // Concurrency cap reached — leave the node ready; the
              // schedule() pass each settling node fires launches it later.
              continue;
            }
            launchNode(node);
            changed = true;
          } else {
            settled.set(node.id, 'skipped');
            enqueue(async () => {
              await this.nodeStateDao.setStatus(
                runId,
                node.id,
                { status: 'skipped', endedAt: Date.now() },
                em,
              );
              await persistItem(node.id, 'status', null, {
                nodeId: node.id,
                status: 'skipped',
                reason: 'an upstream node did not complete',
              });
            });
            changed = true;
          }
        }
      }
      enqueue(() => finishRunIfSettled());
    };

    // The broker gets a capability only when the workflow can call at all —
    // the MCP endpoint answers RUN_NOT_ACTIVE for call-free runs.
    if (calleesOf.size > 0) {
      // Mint one call token per claude caller node up front — the token must
      // exist before the caller turn spawns and reads its mcp-config file.
      // (cursor callers get no endpoint in M2, so no token either.)
      for (const callerId of calleesOf.keys()) {
        const caller = nodesById.get(callerId);
        if (caller?.kind === 'agent' && caller.agent === 'claude') {
          this.callTokens.issue(runId, callerId, mintToken());
        }
      }
      this.callBroker.registerRun(runId, {
        calleesOf,
        launchCalleeTurn,
        persistItem: (nodeId, kind, role, payload) => {
          enqueue(async () => {
            await persistItem(nodeId, kind, role, payload);
          });
        },
        isCancelled: () => cancelRequested,
      });
      // Daemon-side self-check: a dead endpoint degrades SILENTLY child-side
      // (claude exits 0 with an unreachable server), so probe our own route
      // once at run start and leave a system item when it fails. Advisory —
      // callers still launch; they just run without working call tools.
      this.selfCheckCallEndpoint(
        [...calleesOf.keys()]
          .map((id) => nodesById.get(id))
          .find(
            (n): n is WorkflowAgentNode =>
              n?.kind === 'agent' && n.agent === 'claude',
          ) ?? null,
        mcpEndpointFor,
        (message) => {
          enqueue(async () => {
            await persistItem(null, 'system', null, { message });
          });
        },
      );
    }

    // Seed message first, then the roots fan out.
    enqueue(async () => {
      await persistItem(null, 'message', 'user', { text: seedPrompt });
    });
    schedule();
  }

  /**
   * Probe the run's own MCP route with a JSON-RPC initialize (3s cap) and
   * report a failure through `onFailure`. Fire-and-forget: the DAG walk never
   * waits on it. No claude caller → nothing to check in M2 (cursor callers
   * get no endpoint until milestone 3).
   */
  private selfCheckCallEndpoint(
    claudeCaller: WorkflowAgentNode | null,
    mcpEndpointFor: (
      node: WorkflowAgentNode,
    ) => { url: string; token: string } | null,
    onFailure: (message: string) => void,
  ): void {
    if (!claudeCaller) {
      return;
    }
    const endpoint = mcpEndpointFor(claudeCaller);
    if (!endpoint) {
      onFailure(
        'agent-call endpoint unavailable (no bound port or call token) — callers run without call tools',
      );
      return;
    }
    void (async () => {
      try {
        const res = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${endpoint.token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'geniro-selfcheck', version: '0' },
            },
          }),
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        onFailure(
          `agent-call endpoint self-check failed (${err instanceof Error ? err.message : String(err)}) — callers may run without call tools`,
        );
      }
    })();
  }

  /**
   * seed task + each producer's final text under a labeled heading. Producers
   * with no recorded output (triggers — they seed, they don't produce) get no
   * section at all.
   */
  private composePrompt(
    seedPrompt: string,
    producerIds: ReadonlySet<string>,
    nodesById: Map<string, WorkflowNode>,
    finalTexts: Map<string, string>,
  ): string {
    const parts = [seedPrompt];
    for (const producerId of producerIds) {
      const finalText = finalTexts.get(producerId);
      if (finalText === undefined) {
        continue;
      }
      const producer = nodesById.get(producerId);
      const name = producer?.name ?? producerId;
      parts.push(`## Output from ${name}\n\n${finalText}`);
    }
    return parts.join('\n\n');
  }

  private async persist(
    em: EntityManager,
    runId: string,
    nodeId: string | null,
    seq: number,
    kind: ItemKind,
    role: string | null,
    payload: unknown,
  ): Promise<ItemWire> {
    return persistItemAndEmit({ itemDao: this.itemDao, bus: this.bus }, em, {
      runId,
      nodeId,
      seq,
      kind,
      role,
      payload,
    });
  }
}
