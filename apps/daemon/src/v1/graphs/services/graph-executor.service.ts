import { EntityManager } from '@mikro-orm/sqlite';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictException } from '@packages/common';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import { mintToken } from '../../../auth/mint-token';
import { RUNTIME_TOKEN, type RuntimeInfo } from '../../../auth/runtime';
import type {
  AgentEvent,
  AgentTurnHandle,
  AgentTurnInput,
  ApprovalResolution,
} from '../../agents/adapters/adapter.types';
import type { AgentAdapter } from '../../agents/adapters/agent-adapter';
import { ClaudeProbeService } from '../../agents/adapters/claude/claude-probe.service';
import type {
  ClaudeModesCapability,
  ItemWire,
  RunWire,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import { McpSettingsStore } from '../../agents/services/mcp-settings.store';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { RunTeardownService } from '../../agents/services/run-teardown.service';
import { SkillHarvestStore } from '../../agents/services/skill-harvest.store';
import {
  answerFoldsInto,
  foldApprovalAnswer,
  isUserQuestion,
} from '../../agents/utils/approval-answer';
import {
  mapEventToItem,
  terminalStatus,
} from '../../agents/utils/event-to-item';
import { persistItemAndEmit, runToWire } from '../../agents/utils/persist-item';
import { resolveValidCwd } from '../../agents/utils/resolve-cwd';
import { assertWorkflowRun } from '../../agents/utils/run-kind';
import { writeRunStatus } from '../../agents/utils/run-status';
import { createSessionIdSaver } from '../../agents/utils/session-saver';
import {
  unanswerablePayload,
  unansweredRequests,
} from '../../agents/utils/unanswerable';
import type { AgentKind, ItemKind, RunStatus } from '../../runs/runs.types';
import type {
  CalleeTurnOutcome,
  NodeStateWire,
  Workflow,
  WorkflowAgentNode,
  WorkflowNode,
} from '../graphs.types';
import { CALLEE_DESCRIPTION_MAX, calleeSummary } from '../utils/callee-text';
import {
  buildEdgeMaps,
  computeRunOrder,
  onDemandNodeIds,
} from '../utils/graph-order';
import {
  validateRunnableGraph,
  validateWorkflowGraph,
} from '../utils/graph-validate';
import { createTurnSemaphore } from '../utils/turn-semaphore';
import { CallBroker } from './call-broker.service';
import { WorkflowStoreService } from './workflow-store.service';

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
 * True when any node requests an approval mode its CLI's support for must be
 * PROVED against the installed binary — a workflow that asks for none never
 * pays for the probe turn.
 */
function hasProbedApprovalMode(
  workflow: Workflow,
  adapterFor: (kind: AgentKind) => AgentAdapter,
): boolean {
  return workflow.nodes.some(
    (node) =>
      node.kind === 'agent' &&
      adapterFor(node.agent)
        .getConfig()
        .approval.probedModes.includes(node.approval),
  );
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

  /**
   * Runs whose delete is in progress — the graph-side twin of ChatService's
   * `deleting` Set, covering the same window.
   *
   * `startRun` claims the run, then `drive` awaits the capability probes before
   * `driveResolved` registers the aggregate handle. A delete landing in there
   * finds no handle to wait on, destroys the rows, and the walk would then
   * register and write a whole run's items for a run that no longer exists.
   */
  private readonly deleting = new Set<string>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly bus: AgentEventBus,
    private readonly registry: ProcessRegistry,
    private readonly approvals: ApprovalRegistry,
    private readonly adapters: AgentAdapterRegistry,
    private readonly callTokens: CallTokenRegistry,
    private readonly callBroker: CallBroker,
    private readonly claudeProbe: ClaudeProbeService,
    private readonly skillHarvest: SkillHarvestStore,
    private readonly store: WorkflowStoreService,
    private readonly teardown: RunTeardownService,
    @Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo,
    private readonly mcpSettings: McpSettingsStore,
  ) {}

  /**
   * The adapter driving one agent kind — the single kind→adapter dispatch in
   * this file. Every other per-CLI decision asks the adapter it returns; an
   * `if (agent === …)` anywhere else is a missing abstract method.
   */
  private adapterFor(kind: AgentKind): AgentAdapter {
    return this.adapters.for(kind);
  }

  /**
   * Write a workflow run's status AND announce it — the same helper the chat
   * path uses, so the two cannot drift. The chat sidebar lists workflow runs
   * beside chats, and a status written without the announce leaves that row's
   * badge stale until something else forces a refetch: "still running with no
   * active jobs", fixed for one row type and not the other.
   */
  private async setRunStatus(
    em: EntityManager,
    runId: string,
    status: RunStatus,
  ): Promise<void> {
    await writeRunStatus(
      { runDao: this.runDao, bus: this.bus },
      em,
      runId,
      status,
    );
  }

  /**
   * The run-start composition (library lookup → DAG launch) lives in the
   * service layer so the controller stays one-call and a future run-start
   * guard cannot be bypassed from the route.
   */
  async startRunBySlug(
    slug: string,
    input: Pick<StartWorkflowRunInput, 'cwd' | 'prompt'>,
  ): Promise<RunWire> {
    const { workflow } = await this.store.get(slug);
    return this.startRun({
      slug,
      workflow,
      cwd: input.cwd,
      prompt: input.prompt,
    });
  }

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
      await this.setRunStatus(em, run.id, 'failed').catch(() => {});
      throw err;
    }

    if (!this.registry.canStart(run.id)) {
      this.registry.release(run.id);
      this.callTokens.revokeRun(run.id);
      await this.setRunStatus(em, run.id, 'failed');
      throw new ConflictException(
        'RUN_STOPPING',
        'daemon shutdown started before the workflow could launch',
      );
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

  /**
   * Delete a workflow run and everything it owns — a ONE-WAY DOOR, and the
   * graph-side sibling of `ChatService.delete`. The chats sidebar lists both
   * kinds of run, so without this the workflow rows in it were undeletable:
   * the chat route refuses them (`NOT_A_CHAT_RUN`) precisely because deleting
   * one there would skip everything below.
   *
   * The teardown itself is shared ({@link RunTeardownService}). What is
   * graph-specific: the settle promise is the run's AGGREGATE handle (it
   * resolves only after the DAG's final status + `turn_complete` writes), and
   * the CallBroker's per-run call surface has no chat analogue.
   */
  async deleteRun(runId: string): Promise<{ deleted: boolean }> {
    const em = this.em.fork();
    assertWorkflowRun(await this.runDao.getById(runId, em), runId);

    // Claimed BEFORE the cancel, so a walk still crossing the claim→register
    // window sees the delete and abandons itself rather than registering
    // behind our back.
    this.deleting.add(runId);
    try {
      return await this.teardown.purge(em, runId, this.registry.settled(runId));
    } finally {
      // The call surface dies with the run even if the purge threw half-way:
      // leaving it registered would let a child that outlived its run dispatch
      // into rows that are already (partly) gone.
      this.callBroker.unregisterRun(runId);
      this.deleting.delete(runId);
    }
  }

  /** Workflow runs, newest first (the Chats page's run picker). */
  async listRuns(): Promise<RunWire[]> {
    const em = this.em.fork();
    const runs = await this.runDao.listWorkflowRuns(em);
    const previews = await this.itemDao.latestMessageTextPerRun(
      runs.map((run) => run.id),
      em,
    );
    return runs.map((run) => runToWire(run, previews.get(run.id) ?? null));
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
        let seq = (await this.itemDao.maxSeq(run.id, em)) + 1;
        await this.persist(em, run.id, null, seq++, 'error', null, {
          message:
            'workflow run interrupted — the daemon stopped before it finished',
        });
        // The kill took the in-memory registry with it, so no settle path ever
        // swept these — without this the cards come back looking answerable.
        for (const request of unansweredRequests(
          await this.itemDao.getByRun(run.id, -1, em),
        )) {
          await this.persist(
            em,
            run.id,
            request.nodeId,
            seq++,
            'unanswerable',
            null,
            {
              ...request.payload,
              ...(request.nodeId ? { nodeId: request.nodeId } : {}),
            },
          );
        }
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
        await this.setRunStatus(em, run.id, 'failed');
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
  /**
   * Resolve the cursor call capability, then walk the DAG. The probe await
   * lives HERE — off the run-start POST — so the first cursor-caller run on a
   * machine returns its run row instantly and only its execution waits out
   * the probe turn (~90s worst case). Cancel/shutdown during the await is
   * covered by the registry's claim→register intent window.
   */
  private drive(
    em: EntityManager,
    runId: string,
    workflow: Workflow,
    cwd: string,
    seedPrompt: string,
  ): void {
    void (async () => {
      let claudeModes: ClaudeModesCapability;
      try {
        // acceptEdits nodes wait on the claude mode probe the same way cursor
        // callers wait on the MCP-trust probe: cached per installed binary,
        // so only the first such run on a machine pays the probe turn.
        claudeModes = hasProbedApprovalMode(workflow, (kind) =>
          this.adapterFor(kind),
        )
          ? await this.claudeProbe.ensureVerdict()
          : this.claudeProbe.capability();
      } catch {
        // Unknown is NOT a fail — the node runs with its requested mode and
        // any real CLI rejection surfaces loudly in the transcript.
        claudeModes = this.claudeProbe.capability();
      }
      // A delete can have landed while those probes were awaiting, and it has
      // TWO shapes this walk must not survive:
      //   - one still in flight (cancelled, rows not yet gone) — `deleting`;
      //   - one that already finished — the run row is gone, and `deleting`
      //     has been cleared again, so only re-reading catches it.
      // The re-read is resolved FIRST and `deleting` consulted only after, so
      // a delete that starts during the read is still seen by the Set (the
      // chat turn's start applies the same order for the same reason).
      const runStillExists = (await this.runDao.getById(runId, em)) !== null;
      if (this.deleting.has(runId) || !runStillExists) {
        // Abandon the walk: no handle registered, no item written. The delete
        // owns this run's rows from here — writing any would orphan them.
        this.registry.release(runId);
        this.logger.warn(
          `workflow run ${runId} was deleted while starting — abandoning its walk`,
        );
        return;
      }
      this.driveResolved(em, runId, workflow, cwd, seedPrompt, claudeModes);
    })();
  }

  private driveResolved(
    em: EntityManager,
    runId: string,
    workflow: Workflow,
    cwd: string,
    seedPrompt: string,
    claudeModes: ClaudeModesCapability,
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
    let persistenceFailed = false;

    // One serialized write chain for the whole run: seq allocation and
    // persist-then-emit ordering stay correct while N nodes stream at once.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (work: () => Promise<void> | void): void => {
      chain = chain.then(work).catch((err: unknown) => {
        persistenceFailed = true;
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

    /**
     * Drop one node's pending approvals NOW and hand back the work that
     * records each as `unanswerable`.
     *
     * Two halves because they belong at different moments: the sweep must be
     * synchronous at the settle point (a verdict must not slip into the gap),
     * while the rows are written on the serialized chain like every other
     * item. One helper for all FOUR settle paths in this method — a path that
     * swept without writing the rows would leave a card on screen with live
     * buttons that answer into nothing, which is precisely the reported bug.
     */
    const sweepApprovals = (nodeId: string): (() => Promise<void>) => {
      const swept = this.approvals.sweepNode(runId, nodeId);
      return async () => {
        for (const approval of swept) {
          await persistItem(nodeId, 'unanswerable', null, {
            ...unanswerablePayload(approval),
            nodeId,
          }).catch((err: unknown) => {
            this.logger.error(
              `workflow run ${runId} unanswerable item write failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      };
    };

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
          : anyNotCompleted || persistenceFailed
            ? 'failed'
            : 'completed';
        await this.setRunStatus(em, runId, status);
        await persistItem(null, 'turn_complete', null, {
          usage: null,
          stopReason: `workflow_${status}`,
        });
      } catch (err) {
        persistenceFailed = true;
        this.logger.error(
          `workflow run ${runId} finalization failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.setRunStatus(em, runId, 'failed').catch(
          (statusErr: unknown) => {
            this.logger.error(
              `workflow run ${runId} failure-status write failed: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`,
            );
          },
        );
        await persistItem(null, 'error', null, {
          message: 'workflow finalization persistence failed',
        }).catch((itemErr: unknown) => {
          this.logger.error(
            `workflow run ${runId} terminal failure item write failed: ${itemErr instanceof Error ? itemErr.message : String(itemErr)}`,
          );
        });
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
     * What the node's requested approval mode actually becomes, answered by
     * the CLI's own adapter: a mode the installed binary was PROVED to reject
     * degrades, an unprobed one rides through so a genuine rejection stays
     * loud, and a CLI with no permission channel at all lands on auto. The
     * degrade line is surfaced by persistTurnStart below, never silent.
     */
    // Assembled once per run; each adapter takes its OWN slice of it, so a CLI
    // whose probe never ran is not judged against another CLI's verdict.
    const capabilities = { claudeModes };
    const resolveApproval = (node: WorkflowAgentNode): ApprovalResolution =>
      this.adapterFor(node.agent).resolveApprovalMode(
        node.approval,
        this.adapterFor(node.agent).approvalSupportFrom(capabilities),
      );

    /**
     * The node's "turn is starting" bookkeeping shared by DAG launches and
     * callee sub-turns: node_state → running, the status item, and the
     * approval-degrade note. A callee sub-turn passes its callId so the
     * renderer can attribute the status to ONE call even when two parallel
     * calls target the same node.
     */
    const persistTurnStart = (
      node: WorkflowAgentNode,
      callId: string | null = null,
    ): void => {
      enqueue(async () => {
        await this.nodeStateDao.setStatus(
          runId,
          node.id,
          // agentKind stamps which CLI runs this turn — the terminal mirror
          // must resume against it even after the workflow YAML is edited.
          { status: 'running', startedAt: Date.now(), agentKind: node.agent },
          em,
        );
        await persistItem(node.id, 'status', null, {
          nodeId: node.id,
          status: 'running',
          ...(callId ? { callId } : {}),
        });
        const degradeReason = resolveApproval(node).degradeReason;
        if (degradeReason !== null) {
          // A degrade the user cannot see reads as enforced permissions that
          // never were — so ANY mode the CLI could not honour says so here,
          // not just the one that looks dangerous.
          await persistItem(node.id, 'system', null, {
            message: degradeReason,
          });
        }
      });
    };

    /**
     * Whether this agent kind may hold the call tools in THIS run: a CLI whose
     * tools need no machine trust always, one that does only on a probed pass
     * (M3's cursor MCP-trust probe). The one predicate behind every admission
     * surface — the endpoint grant, the token minting, the awareness block,
     * and the self-check — so a change here cannot silently miss a sibling
     * gate.
     */
    const callCapable = (node: WorkflowAgentNode): boolean =>
      !this.adapterFor(node.agent).getConfig().mcp.callToolsRequireTrustProbe;

    /** Nodes that hold the call tools in THIS run (callers, not callees). */
    const isCaller = (node: WorkflowAgentNode): boolean =>
      callCapable(node) && calleesOf.has(node.id);

    /**
     * The caller's MCP grant: call-capable nodes with outgoing call edges get
     * the endpoint (a probe-failed cursor caller degrades — its callees still
     * work, IT just can't call). Null when the server has no bound port
     * yet or the run's token is already revoked.
     */
    const mcpEndpointFor = (
      node: WorkflowAgentNode,
    ): { url: string; token: string; serverName: string } | null => {
      if (!isCaller(node)) {
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
        // Per-run — see `AgentTurnInput.mcpEndpoint.serverName` for why.
        serverName: `geniro-${runId.slice(0, 8)}`,
      };
    };

    /**
     * The caller's "May call" block, naming each callee and what that callee
     * says it does, so the agent can route work from the graph alone — its own
     * role never has to name the team. Callee ROLES stay private (see
     * `calleeSummary`). Null for a non-caller.
     *
     * Kept out of the node's role prompt so an adapter that withholds the call
     * endpoint can withhold this block with it — see `callSurfacePrompt`.
     */
    const callSurfaceFor = (node: WorkflowAgentNode): string | null => {
      const callees = calleesOf.get(node.id);
      if (!callees || !isCaller(node)) {
        return null;
      }
      const lines = callees.map(
        (callee) => `- ${calleeSummary(callee, CALLEE_DESCRIPTION_MAX)}`,
      );
      // The escalation half differs per CLI, and the tool's NAME is the
      // adapter's to spell: a caller whose CLI has a question channel can
      // relay to the user; one without it can only answer-or-time-out.
      const questionTool = this.adapterFor(node.agent).getConfig()
        .questionToolName;
      const questionLine =
        questionTool !== null
          ? `A callee may pause with a {"status":"question"} envelope: answer via answer_agent when your role/context makes you confident; otherwise ask the user with your ${questionTool} tool and relay their answer. Then collect the final result with await_agent.`
          : 'A callee may pause with a {"status":"question"} envelope: answer via answer_agent from your role/context — you cannot escalate to the user; an unanswered question times the call out.';
      return `May call (via the call_agent tool; await_agent collects async results):\n${lines.join('\n')}\n${questionLine}`;
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
      callContext?: { callId: string; resumeSessionId?: string | null },
    ): {
      handle: AgentTurnHandle;
      finish: () => {
        outcome: NodeOutcome;
        finalText: string | null;
        sessionId: string | null;
      };
    } => {
      const adapter = this.adapterFor(node.agent);
      const textChunks: string[] = [];
      let finalText: string | null = null;
      let outcome: NodeOutcome | null = null;
      // The turn's own CLI session — the broker's thread-resume handle.
      let capturedSessionId: string | null = null;

      const saveSessionId = createSessionIdSaver(
        this.nodeStateDao,
        runId,
        node.id,
        null,
        em,
      );
      /**
       * Turns that can raise or relay a question — call-initiated callees AND
       * caller nodes — spawn in the CLI's ask mode (stdin control protocol,
       * stdin held open): headless claude strips its question tool entirely
       * under --dangerously-skip-permissions (probe-verified on 2.1.202), so
       * without this an 'auto' callee could never ask and an 'auto' caller
       * could never escalate. The daemon auto-approves the plain permission
       * requests in onEvent below, so an 'auto' node keeps today's unattended
       * semantics. A CLI with no question channel is never question-capable,
       * so it keeps its requested mode.
       */
      const questionCapable =
        adapter.getConfig().questionToolName !== null &&
        (callContext !== undefined || isCaller(node));
      const approval = resolveApproval(node).mode;
      // The same switch the chat panel writes: a graph node runs in a folder
      // too, and a server the user turned off there stays off for every agent
      // that runs in it.
      const disabledMcpServers = this.mcpSettings.disabled(node.agent, cwd);
      const input: AgentTurnInput = {
        prompt,
        cwd,
        model: node.model ?? null,
        resumeSessionId: callContext?.resumeSessionId ?? null,
        systemPrompt: node.role ?? null,
        callSurfacePrompt: callSurfaceFor(node),
        // A questionCapable AUTO node still spawns in ask mode (the question
        // channel needs the stdio dialogue; the daemon auto-approves plain
        // permissions below). ask/acceptEdits already carry the stdio
        // dialogue, so they spawn as themselves.
        approvalMode: questionCapable && approval === 'auto' ? 'ask' : approval,
        mcpEndpoint: mcpEndpointFor(node),
        disabledMcpServers,
      };
      const onEvent = (event: AgentEvent): void => {
        enqueue(async () => {
          if (event.type === 'session') {
            capturedSessionId = event.sessionId;
            await saveSessionId(event.sessionId);
            return;
          }
          if (event.type === 'slash_commands') {
            // The CLI's own invokable set for this run's cwd — feeds the
            // composer's `/` autocomplete, never the transcript.
            this.skillHarvest.record(node.agent, cwd, event.commands);
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
          if (event.type === 'approval_request') {
            // The caller-bridge admits ONLY AskUserQuestion by NAME: bridging
            // on the CLI-owned requires_user_interaction flag alone could let
            // a future interactive tool bypass an 'ask' node's human gate via
            // version drift. A flag-only request stays on the approval path
            // (card or daemon auto-approve per node.approval) with a warning
            // so the drift is loud, never silent.
            const isQuestion = isUserQuestion(
              adapter.getConfig().questionToolName,
              event.toolName,
            );
            if (!isQuestion && event.requiresUserInteraction === true) {
              this.logger.warn(
                `interactive control_request for unrecognized tool '${event.toolName}' on ${node.id} — kept on the approval path, not bridged to the caller`,
              );
            }
            if (callContext && isQuestion) {
              // A call-initiated callee's question goes to its CALLER (the
              // M4 Q&A bridge) — never to a renderer card. The broker parks
              // it; answer_agent delivers the answer through these closures.
              //
              // The payload is the CLI's own, so the ADAPTER projects it and
              // folds the answer back in: the executor bridges the question
              // without ever knowing which CLI's shape it is carrying.
              const question = adapter.questionFrom(event.input);
              const parked =
                question !== null &&
                this.callBroker.parkQuestion(runId, callContext.callId, {
                  question: question.text,
                  options: question.options,
                  payload: event.input,
                  deliver: (answer) =>
                    handle.respondApproval(
                      event.id,
                      true,
                      adapter.withAnswer(event.input, answer),
                    ),
                  fail: () => handle.cancel(),
                });
              if (!parked) {
                // Unknown/settled call (or a second question raced the
                // first) — deny so the callee continues instead of hanging
                // on a question nobody can answer. An adapter that projects
                // NO question takes this path too: parking a blank question
                // would strand the caller on something it cannot answer.
                handle.respondApproval(event.id, false);
              }
              return;
            }
            if (questionCapable && approval === 'auto' && !isQuestion) {
              // The daemon-side stand-in for --dangerously-skip-permissions:
              // ONLY an 'auto' node spawned in ask mode (for the question
              // channel) skips plain permissions — approve with the input
              // unchanged, no transcript item (matching auto-mode silence).
              // ask/acceptEdits nodes keep the human card for every
              // permission the CLI routes to the stdio dialogue.
              handle.respondApproval(event.id, true, event.input);
              return;
            }
          }
          const mapped = mapEventToItem(event);
          if (mapped) {
            // A callee sub-turn tags every streamed item with its callId so
            // the renderer can nest the whole sub-turn under its call block —
            // unambiguous even when parallel calls hit the SAME node.
            try {
              await persistItem(node.id, mapped.kind, mapped.role, {
                ...(mapped.payload as Record<string, unknown>),
                nodeId: node.id,
                ...(callContext ? { callId: callContext.callId } : {}),
              });
            } catch (err) {
              // The card can't be shown — deny to unblock the parked node CLI
              // so the node settles instead of hanging forever on a verdict
              // that can never arrive (mirrors the chat service's card path;
              // the track below, which routes the verdict, would be skipped).
              if (event.type === 'approval_request') {
                handle.respondApproval(event.id, false);
              }
              throw err;
            }
          }
          if (event.type === 'approval_request') {
            this.approvals.track({
              runId,
              nodeId: node.id,
              requestId: event.id,
              toolName: event.toolName,
              input: event.input,
              respond: (allow, answer) => {
                const delivered = handle.respondApproval(
                  event.id,
                  allow,
                  // The answer folds ONLY into AskUserQuestion (shared
                  // helper with the chat service) so the verdict channel
                  // can never mutate an arbitrary tool's input.
                  foldApprovalAnswer(
                    adapter,
                    event.toolName,
                    event.input,
                    allow,
                    answer,
                  ),
                );
                if (delivered) {
                  enqueue(async () => {
                    await persistItem(node.id, 'approval_verdict', null, {
                      id: event.id,
                      nodeId: node.id,
                      allow,
                      // Recorded only when it was actually folded — the
                      // transcript must never claim an answer the agent
                      // did not receive.
                      ...(answerFoldsInto(
                        adapter.getConfig().questionToolName,
                        event.toolName,
                        allow,
                        answer,
                      )
                        ? { answer }
                        : {}),
                    });
                  });
                }
                return delivered;
              },
            });
          }
        });
      };
      const handle: AgentTurnHandle = adapter.start(input, onEvent);

      const finish = (): {
        outcome: NodeOutcome;
        finalText: string | null;
        sessionId: string | null;
      } => {
        // A clean exit with no result line still completes the node — the
        // synthetic-completion mirror of the chat turn's finalizer.
        const finalOutcome: NodeOutcome =
          outcome ?? (cancelRequested ? 'cancelled' : 'completed');
        const text =
          finalOutcome === 'completed'
            ? (finalText ?? textChunks.join(''))
            : finalText;
        return {
          outcome: finalOutcome,
          finalText: text,
          sessionId: capturedSessionId,
        };
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
      let finish: () => {
        outcome: NodeOutcome;
        finalText: string | null;
        sessionId: string | null;
      };
      try {
        ({ handle, finish } = beginAgentTurn(node, prompt));
      } catch (err) {
        // Gated like the three sibling settle paths (:1193, and the two cancel
        // routes): a callable DAG node can hold live CALLEE turns alongside its
        // DAG turn — which is why `liveTurnsByNode` exists at all — so sweeping
        // unconditionally here would mark a still-answerable card unanswerable
        // and drain a live caller's parked questions, because an unrelated
        // turn failed to spawn.
        const lastTurn = releaseNodeTurn(node.id);
        const recordSwept = lastTurn ? sweepApprovals(node.id) : null;
        if (lastTurn) {
          this.callBroker.drainCaller(runId, node.id);
        }
        settled.set(node.id, 'failed');
        enqueue(async () => {
          await recordSwept?.();
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
            const recordSwept = sweepApprovals(node.id);
            // A settled caller can never answer_agent — fail its parked
            // callee questions now instead of letting the TTL grind out.
            this.callBroker.drainCaller(runId, node.id);
            await recordSwept();
          }
          runningHandles.delete(node.id);
          const { outcome, finalText } = finish();
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
            settled.set(node.id, outcome);
            if (outcome === 'completed') {
              finalTexts.set(node.id, finalText ?? '');
            }
          } catch (err) {
            persistenceFailed = true;
            settled.set(node.id, 'failed');
            finalTexts.delete(node.id);
            const message = `node bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`;
            await this.nodeStateDao
              .setStatus(
                runId,
                node.id,
                {
                  status: 'failed',
                  endedAt: Date.now(),
                  error: message,
                },
                em,
              )
              .catch((statusErr: unknown) => {
                this.logger.error(
                  `workflow run ${runId} node ${node.id} failure-status write failed: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`,
                );
              });
            await persistItem(node.id, 'status', null, {
              nodeId: node.id,
              status: 'failed',
              error: message,
            }).catch((itemErr: unknown) => {
              this.logger.error(
                `workflow run ${runId} node ${node.id} failure item write failed: ${itemErr instanceof Error ? itemErr.message : String(itemErr)}`,
              );
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
      sessionId: null,
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
      resumeSessionId: string | null,
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
          let finish: () => {
            outcome: NodeOutcome;
            finalText: string | null;
            sessionId: string | null;
          };
          try {
            persistTurnStart(callee, callId);
            ({ handle, finish } = beginAgentTurn(callee, message, {
              callId,
              resumeSessionId,
            }));
          } catch (err) {
            let recordSwept: (() => Promise<void>) | null = null;
            if (releaseNodeTurn(callee.id)) {
              recordSwept = sweepApprovals(callee.id);
              this.callBroker.drainCaller(runId, callee.id);
            }
            enqueue(async () => {
              await recordSwept?.();
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
              // Mirror the DAG-launch catch: persistTurnStart already emitted
              // the 'running' status item, and the renderer only balances it
              // against a terminal one — without this the agents panel counts
              // the callee as live for the rest of the run.
              await persistItem(callee.id, 'status', null, {
                nodeId: callee.id,
                status: 'failed',
                ...(callId ? { callId } : {}),
              }).catch(() => {});
            });
            return {
              status: 'failed',
              finalText: null,
              error: `turn start failed: ${err instanceof Error ? err.message : String(err)}`,
              sessionId: null,
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
                sessionId: null,
              };
              try {
                if (releaseNodeTurn(callee.id)) {
                  const recordSwept = sweepApprovals(callee.id);
                  // A callee can itself be a caller — its own parked
                  // sub-questions die with its last live turn.
                  this.callBroker.drainCaller(runId, callee.id);
                  await recordSwept();
                }
                subTurnHandles.delete(callId);
                const { outcome, finalText, sessionId } = finish();
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
                  sessionId,
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
                  callId,
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
      // Mint one call token per call-capable caller node up front — the token
      // must exist before the caller turn spawns and reads its config (the
      // claude mcp-config file / the merged .cursor/mcp.json entry). A
      // probe-failed cursor caller gets no token: every admission surface
      // keys on the same callCapable predicate.
      for (const callerId of calleesOf.keys()) {
        const caller = nodesById.get(callerId);
        if (caller?.kind === 'agent' && callCapable(caller)) {
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
        isNodeLive: (nodeId) => liveTurnsByNode.has(nodeId),
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
              n?.kind === 'agent' && callCapable(n),
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
    // No per-machine gate can shut a caller out any more: every adapter hands
    // its own CLI the endpoint in-protocol, so having outgoing call edges is
    // the whole admission predicate. The M3 "probe verdict shut this caller
    // out" system item went with the probe.
    schedule();
  }

  /**
   * Probe the run's own MCP route with a JSON-RPC initialize (3s cap) and
   * report a failure through `onFailure`. Fire-and-forget: the DAG walk never
   * waits on it. No call-capable caller → nothing to check (a probe-failed
   * cursor caller gets no endpoint and degrades visibly instead).
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
