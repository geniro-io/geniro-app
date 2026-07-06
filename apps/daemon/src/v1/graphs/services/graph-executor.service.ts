import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException, ConflictException } from '@packages/common';

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
  NodeStateWire,
  Workflow,
  WorkflowAgentNode,
  WorkflowNode,
} from '../graphs.types';
import { buildEdgeMaps, computeRunOrder } from '../utils/graph-order';
import {
  validateRunnableGraph,
  validateWorkflowGraph,
} from '../utils/graph-validate';

/** How one node's turn ended (the run-level rollup derives from these). */
type NodeOutcome = 'completed' | 'failed' | 'cancelled' | 'skipped';

/**
 * Max CLI agent processes one workflow run drives at once. A wide DAG level
 * would otherwise spawn every ready node simultaneously — N full CLI agents on
 * one machine. Ready nodes beyond the cap stay queued; each settling node
 * re-enters schedule(), which launches them as slots free up.
 */
const MAX_PARALLEL_NODES = 4;

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
    // Milestone-1 guard: call edges are drawable/persistable statics, but the
    // call runtime (CallBroker + MCP endpoint) lands in milestone 2 — without
    // it a call-only node would launch at run start with only the seed prompt.
    // Milestone 2 removes this check.
    if (input.workflow.edges.some((edge) => edge.kind === 'call')) {
      throw new BadRequestException(
        'GRAPH_CALL_RUNTIME_UNAVAILABLE',
        'This workflow has call edges — agent-to-agent calls are not runnable yet; remove the call edges to run it today',
      );
    }
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
    try {
      for (const node of input.workflow.nodes) {
        await this.nodeStateDao.createPending(run.id, node.id, em);
      }
    } catch (err) {
      // Failed before drive() registered the aggregate handle — drop the claim
      // and close the run so it is not wedged as permanently busy/running
      // (mirror of the chat turn's pre-handle catch).
      this.registry.release(run.id);
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

    const finalTexts = new Map<string, string>();
    const settled = new Map<string, NodeOutcome>();
    const runningHandles = new Map<string, AgentTurnHandle>();
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
        // Nodes that never started settle as cancelled in the next pass.
        enqueue(() => schedule());
      },
      // Approvals route through the ApprovalRegistry per request, not the
      // aggregate — a run-level respond has no single target turn.
      respondApproval: () => false,
    };
    this.registry.register(runId, aggregateHandle);

    const finishRunIfSettled = async (): Promise<void> => {
      if (runFinished || settled.size !== nodes.length) {
        return;
      }
      runFinished = true;
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
      try {
        await persistItem(null, 'turn_complete', null, {
          usage: null,
          stopReason: `workflow_${status}`,
        });
        await this.runDao.updateById(runId, { status }, em);
      } finally {
        // The aggregate handle MUST settle even if the final writes fail, or
        // the ProcessRegistry entry leaks and the run can never be re-driven.
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

    const launchNode = (node: WorkflowAgentNode): void => {
      const adapter: AgentAdapter =
        node.agent === 'claude' ? this.claude : this.cursor;
      const textChunks: string[] = [];
      let finalText: string | null = null;
      let outcome: NodeOutcome | null = null;

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

      const prompt = this.composePrompt(
        seedPrompt,
        producersOf.get(node.id) ?? new Set(),
        nodesById,
        finalTexts,
      );

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
          systemPrompt: node.role ?? null,
          approvalMode: node.approval,
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
      runningHandles.set(node.id, handle);

      void handle.done.then(() => {
        enqueue(async () => {
          this.approvals.sweepNode(runId, node.id);
          runningHandles.delete(node.id);
          // A clean exit with no result line still completes the node — the
          // synthetic-completion mirror of the chat turn's finalizer.
          const finalOutcome: NodeOutcome =
            outcome ?? (cancelRequested ? 'cancelled' : 'completed');
          if (finalOutcome === 'completed' && finalText === null) {
            finalText = textChunks.join('');
          }
          settled.set(node.id, finalOutcome);
          if (finalOutcome === 'completed') {
            finalTexts.set(node.id, finalText ?? '');
          }
          try {
            await this.nodeStateDao.setStatus(
              runId,
              node.id,
              {
                status: finalOutcome,
                endedAt: Date.now(),
                error: finalOutcome === 'failed' ? 'node turn failed' : null,
              },
              em,
            );
            await persistItem(node.id, 'status', null, {
              nodeId: node.id,
              status: finalOutcome,
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

    /**
     * Launch every node whose producers all completed; settle nodes whose
     * producers can no longer complete. Loops until a pass changes nothing
     * (skips cascade down the graph in one call).
     */
    const schedule = (): void => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of nodes) {
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

    // Seed message first, then the roots fan out.
    enqueue(async () => {
      await persistItem(null, 'message', 'user', { text: seedPrompt });
    });
    schedule();
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
