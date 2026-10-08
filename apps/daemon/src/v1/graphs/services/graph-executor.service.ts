import { EntityManager } from '@mikro-orm/sqlite';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { BadRequestException, ConflictException } from '@packages/common';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import { RUNTIME_TOKEN, type RuntimeInfo } from '../../../auth/runtime';
import type {
  AgentEvent,
  AgentTurnHandle,
  AgentTurnInput,
  ApprovalResolution,
  InstalledApprovalSupport,
  TurnImage,
} from '../../agents/adapters/adapter.types';
import type { AgentAdapter } from '../../agents/adapters/agent-adapter';
import {
  type AttachmentWire,
  type ChatListScope,
  type ChatTotalsWire,
  type HostArtifact,
  type HostArtifactOutcome,
  type HostArtifactRow,
  type ItemWire,
  type PersistedResetWake,
  type RunCallSeed,
  type RunWire,
  type SendMessageImage,
} from '../../agents/chat.types';
import {
  CALL_CONTEXT_SNAPSHOT_LIMIT,
  CallContextDao,
} from '../../agents/dao/call-context.dao';
import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import { ArtifactBroker } from '../../agents/services/artifact.broker';
import { ArtifactStoreService } from '../../agents/services/artifact-store.service';
import { AttachmentStoreService } from '../../agents/services/attachment-store.service';
import { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import { McpHarvestStore } from '../../agents/services/mcp-harvest.store';
import {
  partialOwnerKey,
  PartialStreamService,
} from '../../agents/services/partial-stream.service';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { PullRequestCaptureService } from '../../agents/services/pull-request-capture.service';
import { RunGroupsService } from '../../agents/services/run-groups.service';
import { RunTeardownService } from '../../agents/services/run-teardown.service';
import { SkillHarvestStore } from '../../agents/services/skill-harvest.store';
import {
  type AgentOptionsSnapshot,
  readAgentOptions,
  writeAgentOptions,
} from '../../agents/utils/agent-options';
import {
  deliverApprovalAnswer,
  isUserQuestion,
} from '../../agents/utils/approval-answer';
import {
  AUTO_COMPACT_COMMAND,
  autoCompactDue,
  autoCompactNotice,
  type AutoCompactReading,
} from '../../agents/utils/auto-compact';
import { BackgroundWorkCounts } from '../../agents/utils/background-work-counts';
import { callNumber, readCallSeed } from '../../agents/utils/call-seed';
import { asksForSecret } from '../../agents/utils/card-questions';
import { withCarriedContext } from '../../agents/utils/carried-context';
import { CompactionRows } from '../../agents/utils/compaction-rows';
import {
  mapEventToItem,
  restatesRunAsWorking,
  terminalStatus,
} from '../../agents/utils/event-to-item';
import { hostMcpServerName } from '../../agents/utils/host-question';
import { asRecord, parseJsonColumn } from '../../agents/utils/json-util';
import { sanitizeModelParameters } from '../../agents/utils/model-parameters';
import {
  delegateCloseEvent,
  ownerFields,
  strandedDelegates,
} from '../../agents/utils/open-delegates';
import {
  shellCloseEvent,
  strandedShells,
} from '../../agents/utils/open-shells';
import { persistItemAndEmit, runToWire } from '../../agents/utils/persist-item';
import {
  nodePolledSpend,
  pollsSpendFor,
  withNodePolledSpend,
} from '../../agents/utils/polled-spend';
import { resolveValidConfigDir } from '../../agents/utils/resolve-config-dir';
import { resolveValidCwd } from '../../agents/utils/resolve-cwd';
import {
  assertWorkflowRun,
  type WorkflowRun,
} from '../../agents/utils/run-kind';
import {
  readPersistedResetWakes,
  resetWakesWire,
} from '../../agents/utils/run-reset-wakes';
import {
  type RunStatusAnnounce,
  writeRunStatus,
} from '../../agents/utils/run-status';
import {
  callSessionKey,
  nodeSessionKey,
  runSessionKeyPrefix,
} from '../../agents/utils/session-keys';
import { createSessionIdSaver } from '../../agents/utils/session-saver';
import { snapshotPoolKinds } from '../../agents/utils/snapshot-config-dirs';
import {
  unanswerablePayload,
  unansweredRequests,
} from '../../agents/utils/unanswerable';
import {
  addUsage,
  carriesUsage,
  emptyTotals,
  turnMemberOf,
  type UsageFigures,
  usageFiguresFrom,
} from '../../agents/utils/usage-figures';
import {
  AgentKind,
  type ItemKind,
  type RunStatus,
} from '../../runs/runs.types';
import type {
  CalleePoolPlan,
  CalleeTurnOutcome,
  NodeStateWire,
  PoolSkip,
  ResetWakesCancelled,
  Workflow,
  WorkflowAgentNode,
  WorkflowAgentPoolMember,
  WorkflowNode,
} from '../graphs.types';
import { CALL_START_BRIEF_MAX } from '../graphs.types';
import {
  fallsThroughPool,
  poolHandOffNotice,
  poolHandOffPrompt,
  poolMembersOf,
} from '../utils/agent-pool';
import { geniroSideFailure, readCalleeFailure } from '../utils/callee-failure';
import { CALLEE_DESCRIPTION_MAX, calleeSummary } from '../utils/callee-text';
import {
  callerConversationOf,
  callerKey,
  callerNodeOf,
} from '../utils/caller-key';
import {
  buildEdgeMaps,
  computeRunOrder,
  isExecutableNode,
  isNonExecutableNode,
  onDemandNodeIds,
} from '../utils/graph-order';
import {
  validateRunnableGraph,
  validateWorkflowGraph,
} from '../utils/graph-validate';
import { openCalls, openNodeTurns } from '../utils/open-call-work';
import { MAX_PARALLEL_AGENTS } from '../utils/parallelism';
import { resetWakePrompt } from '../utils/reset-wake-prompt';
import { createTurnSemaphore } from '../utils/turn-semaphore';
import { workflowSnapshotOf } from '../utils/workflow-snapshot';
import { CallBroker } from './call-broker.service';
import { RunWorkflowService } from './run-workflow.service';
import { WorkflowStoreService } from './workflow-store.service';

/** How one node's turn ended (the run-level rollup derives from these). */
type NodeOutcome = 'completed' | 'failed' | 'cancelled' | 'skipped';

/**
 * The statuses a node's turn ENDS on — the ones an off-turn stretch may take
 * the badge from, and hand it back to.
 *
 * `pending` and `running` are deliberately absent and are not an oversight: a
 * node that has yet to start has no turn to carry on from, and one already
 * running is drawn as working by the turn that is running it. Restating either
 * would write a `running` row that nothing balances, and the renderer counts
 * those rows (`computeAgentActivity`) rather than reading a level.
 */
const NODE_OUTCOMES: ReadonlySet<string> = new Set<NodeOutcome>([
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);

/**
 * How several instruction blocks wired to one node are joined — the blank
 * line `composeTurnInstructions` puts between the parts, so a block reads as
 * its own paragraph rather than running into its neighbour.
 */
const INSTRUCTION_BLOCK_SEPARATOR = '\n\n';

export interface StartWorkflowRunInput {
  /** Library slug — persisted as `Run.workflowId`. */
  slug: string;
  workflow: Workflow;
  /** Shared working folder every node runs in. */
  cwd: string;
  /** The user's task — seeds every node's prompt. */
  prompt: string;
  /** Pictures pasted with the task, for the agents the trigger feeds. */
  images?: SendMessageImage[];
  /**
   * The app's global custom instructions, snapshotted onto the run like a
   * chat's. Every agent node composes it BEHIND its own `role`.
   */
  customInstructions?: string;
  /**
   * What the board card this run works asks of it — its label instructions and
   * the report ask, already composed. Absent for a run started from the
   * library; every agent node composes it right after the user's own text.
   */
  taskInstructions?: string;
  /**
   * The user's per-CLI switches, snapshotted onto the run like the
   * instructions above; each node's turn carries its own CLI's slice.
   */
  agentOptions?: AgentOptionsSnapshot;
  /**
   * The board card this run was started for, when one was.
   *
   * Absent for every run started from the workflow library, which is the case
   * `Run.taskId` describes as "a run nobody started from a card". A task run
   * sets it because it is one half of the run↔task edge — `Task.runId` is the
   * other, written by `TaskRunsService` in the same operation — and without it
   * `TaskSettleService` cannot move the card when the graph finishes.
   */
  taskId?: string;
  /**
   * That card's identifier (`GEN-12`), on `taskId`'s own terms and passed in
   * for the same reason it is on the chat path: see `Run.taskIdentifier`.
   */
  taskIdentifier?: string;
  /**
   * A name for the run, overriding the deliberate `title: null` below.
   *
   * Only a caller that has a better name than the seed prompt passes one, and
   * today that is a task run, whose card already carries the title a person
   * wrote. Nothing else should: see the block at the `title` field for why a
   * run of a workflow must not be stamped with that workflow's own name.
   */
  title?: string;
  /**
   * The sidebar group to file this run under, overriding the workflow's own
   * auto-file rule.
   *
   * A task run belongs to its PROJECT's group — the same answer the chat arm of
   * `TaskRunsService` gives — because the run works in a worktree, a path no
   * folder rule has ever seen. Absent means resolve the rule as usual.
   */
  groupId?: string | null;
}

/**
 * What each of the workflow's CLIs has proved about its approval modes, keyed
 * by agent kind.
 *
 * Awaited only for a CLI some node asks a PROBED mode of — a workflow that
 * asks for none never pays for a probe turn — and each CLI's answer is its own
 * adapter's, so no node is ever judged against another CLI's binary.
 */
async function approvalSupportByKind(
  workflow: Workflow,
  adapterFor: (kind: AgentKind) => AgentAdapter,
): Promise<Map<AgentKind, InstalledApprovalSupport>> {
  const needsProbe = new Map<AgentKind, boolean>();
  for (const node of workflow.nodes) {
    if (node.kind !== 'agent') {
      continue;
    }
    // A pool member runs its own approval mode — else the node's — on its
    // OWN CLI.
    for (const { agent, approval } of poolMembersOf(node)) {
      const probed = adapterFor(agent)
        .getConfig()
        .approval.probedModes.includes(approval ?? node.approval);
      needsProbe.set(agent, (needsProbe.get(agent) ?? false) || probed);
    }
  }
  const support = new Map<AgentKind, InstalledApprovalSupport>();
  for (const [kind, probed] of needsProbe) {
    const adapter = adapterFor(kind);
    support.set(
      kind,
      probed
        ? await adapter.settledApprovalSupport()
        : adapter.currentApprovalSupport(),
    );
  }
  return support;
}

/**
 * One node setting that was dropped because its CLI cannot honour it — a
 * `configDir` on a CLI with no such mechanism, an `effort` level the CLI does
 * not list.
 *
 * ONE type for both, and one system-item template, because the two are the
 * same event: a value the builder would have refused, arriving on a workflow
 * that came in as YAML, dropped rather than passed to a CLI that would either
 * ignore it or fail on it. A second parallel struct and loop is how the two
 * would drift into wording only one of them explains.
 *
 * Private to this file (only `withResolvedNodeSettings` produces it and only
 * `driveResolved` reads it), so it stays here rather than in `graphs.types.ts`
 * — it is not part of the module's shared vocabulary and nothing on the wire
 * carries it.
 */
/**
 * The run-scoped facts every node of one walk shares.
 *
 * Bundled rather than appended as positionals, because the three are all
 * strings-or-null and sit adjacent: `string` is assignable to `string | null`,
 * so a transposition of `cwd`, `seedPrompt` and `customInstructions` is caught
 * in only one direction and the compiler would wave the other through. Each
 * new run-scoped snapshot is the same shape, so the next one goes in here
 * instead of widening two signatures again.
 */
/**
 * What one node turn ended with, read once its events have drained — see
 * `beginAgentTurn`'s `finish`.
 */
interface NodeTurnResult {
  outcome: NodeOutcome;
  finalText: string | null;
  sessionId: string | null;
  /** The last context reading the turn reported — what auto-compaction judges. */
  reading: AutoCompactReading;
  /**
   * The FIRST positive context reading the turn reported — its opening size,
   * which after a compaction is what that compaction left behind.
   */
  firstTokens: number | null;
  /** The registry key the turn ran under — the conversation it belongs to. */
  sessionKey: string;
  /**
   * The last failure the CLI itself reported this turn, verbatim — what a CALLER
   * is told instead of the constant this field replaced. Null when the turn
   * reported none, which for a `failed` outcome means the failure was geniro's
   * own. See `utils/callee-failure.ts`.
   */
  error: string | null;
  /** Whether the turn called any tool of its own — whether it did any work. */
  madeToolCalls: boolean;
}

interface RunContext {
  /** Shared working folder every node runs in, already canonicalized. */
  cwd: string;
  /** The user's task — seeds every node's prompt. */
  seedPrompt: string;
  /** The run's snapshotted global instructions; every node composes it. */
  customInstructions: string | null;
  /** The card's instructions for a task run; every node composes them too. */
  taskInstructions: string | null;
  /** The run's snapshotted per-CLI switches; each node reads its CLI's slice. */
  agentOptions: AgentOptionsSnapshot;
  /**
   * Each node's CLI session from an earlier pass of this run, so a follow-up
   * carries every agent's conversation on instead of starting it over. Empty
   * on a run's first pass.
   */
  resumeSessions: ReadonlyMap<string, string>;
  /**
   * Each node's context window as an earlier pass recorded it. Every user
   * message starts a pass and nearly every root-node turn is a pass's FIRST, so
   * without this those turns never carried the node's `--autocompact` threshold.
   */
  nodeWindows: ReadonlyMap<string, number>;
  /**
   * The calls an earlier pass of this run made, read back off the transcript
   * so this pass's call ids continue past them and their conversations can be
   * continued — see `RunCallSeed`. Null on a run's first pass.
   */
  callSeed: RunCallSeed | null;
  /**
   * The seed row is already written: a follow-up persists its message before
   * the walk starts, because the route answers with that row.
   */
  seedPersisted: boolean;
  /** Pictures that came with the seed — for the agents a trigger feeds. */
  seedImages: TurnImage[];
  /** The same pictures as the seed row's attachments, when this pass writes it. */
  seedAttachments: readonly AttachmentWire[];
}

/** How a follow-up reaches a workflow run that is still being walked. */
interface LiveRunControl {
  /**
   * Hand the message to the agents the trigger feeds. Null once the run has
   * finished, which leaves the caller to walk it again from the trigger.
   */
  deliver(text: string, images: SendMessageImage[]): Promise<ItemWire | null>;
  /** Hand the message to the callee of ONE running call — see `deliverToCall`. */
  deliverToCall(
    nodeId: string,
    callId: string,
    text: string,
    images: SendMessageImage[],
  ): Promise<ItemWire>;
}

/** The refusal for a message addressed to a call that is not running. */
function callNotRunning(): ConflictException {
  return new ConflictException(
    'CALL_NOT_RUNNING',
    'this call is no longer running — message the workflow instead',
  );
}

/** A user message row's payload — pictures only when there are any. */
function messagePayload(
  text: string,
  stored: readonly AttachmentWire[],
): { text: string; images?: AttachmentWire[] } {
  return { text, ...(stored.length > 0 ? { images: [...stored] } : {}) };
}

interface DroppedNodeSetting {
  nodeId: string;
  /** The node's own name, or its id when unnamed — the same fallback every
   * other user-facing mention of a node uses. */
  name: string;
  /** What the setting is called in the sentence, e.g. `a config directory`. */
  setting: string;
  /** What the node asked for, quoted back so the user can find it. */
  value: string;
  /** The adapter's own sentence, shown to the user unchanged. */
  reason: string;
}

/**
 * A copy of `workflow` whose agent nodes carry the CANONICAL form of their
 * config directory, refusing any that cannot be used.
 *
 * Two things at once, deliberately: the refusal (a bad path fails the run
 * once, up front, rather than one node halfway through the graph) and the
 * canonicalization (what a turn spawns with must be what was actually
 * checked — `resolveValidCwd` one line above has always worked this way, and
 * a `configDir` that stayed raw could reach argv as a symlink re-pointed
 * after the check).
 *
 * A node whose CLI declares no plugin mechanism has the field STRIPPED — not
 * validated, not refused, not passed on. Refusing a whole run over a path that
 * adapter would ignore would be geniro inventing a failure, and handing it to
 * the turn anyway would be geniro going silent, which is the very thing this
 * field exists to prevent. Only the in-memory run copy is stripped; the
 * workflow on disk keeps whatever the user wrote.
 *
 * Every strip is REPORTED back, because "stripped quietly" is its own version
 * of going silent: a workflow imported from YAML can carry a `configDir` on a
 * CLI that has no such mechanism — the builder never offered the field, so the
 * user never saw it refused — and the run would otherwise proceed as though
 * the node had never named one. The caller turns each entry into a run-level
 * system item carrying the adapter's own reason.
 */
function withResolvedNodeSettings(
  workflow: Workflow,
  adapterFor: (kind: AgentKind) => AgentAdapter,
): { workflow: Workflow; dropped: DroppedNodeSetting[] } {
  const dropped: DroppedNodeSetting[] = [];
  const nodes = workflow.nodes.map((node) => {
    if (node.kind !== 'agent') {
      return node;
    }
    const drop =
      (member: number) =>
      (setting: string, value: string, reason: string): void => {
        dropped.push({
          nodeId: node.id,
          name: node.name ?? node.id,
          setting:
            node.pool && node.pool.length > 0
              ? `${setting} (pool member ${member})`
              : setting,
          value,
          reason,
        });
      };
    // Every member of the pool is checked as the node itself is: each runs
    // under its own CLI, which is the one whose vocabulary decides.
    const resolved = resolveMemberSettings(node, adapterFor, drop(1));
    return resolved.pool
      ? {
          ...resolved,
          pool: resolved.pool.map((member, index) =>
            resolveMemberSettings(member, adapterFor, drop(index + 2)),
          ),
        }
      : resolved;
  });
  return { workflow: { ...workflow, nodes }, dropped };
}

/**
 * One configuration's CLI settings — a node's own, or one pool member's —
 * checked against that configuration's CLI: an unusable value is reported
 * through `drop` and removed, a usable path canonicalized.
 */
function resolveMemberSettings<T extends WorkflowAgentPoolMember>(
  settings: T,
  adapterFor: (kind: AgentKind) => AgentAdapter,
  drop: (setting: string, value: string, reason: string) => void,
): T {
  let resolved = settings;
  if (resolved.configDir) {
    const reason = adapterFor(resolved.agent).getConfig().configDir
      .unavailableReason;
    if (reason === null) {
      resolved = {
        ...resolved,
        configDir: resolveValidConfigDir(resolved.configDir),
      };
    } else {
      drop('a config directory', resolved.configDir, reason);
      resolved = { ...resolved, configDir: undefined };
    }
  }
  if (resolved.effort) {
    // Asked of the ADAPTER, never of a list here: the levels are the CLI's
    // own, and `listEfforts` is already the one answer the composer's picker
    // and this run agree on.
    //
    // Only for a CLI whose list is COMPLETE, which is the same rule
    // `EffortsService.accepts` follows. A CLI whose levels belong to the
    // MODEL has only a union here, and `gpt-5.2`'s `extra-high` is absent
    // from it — dropping against that stripped a level a chat accepts, so the
    // same value ran at the CLI's default on a node while the app reported it
    // as unsupported. There the turn's own driver checks the value against
    // the model that runs it and reports what does not apply.
    const adapter = adapterFor(resolved.agent);
    const levels = adapter.listEfforts();
    const effort = resolved.effort;
    if (
      adapter.getConfig().effortsAreExhaustive &&
      !levels.some((level) => level.id === effort)
    ) {
      drop(
        'a reasoning effort',
        effort,
        adapter.getConfig().effortsUnavailableReason ??
          (levels.length === 0
            ? `${resolved.agent} lists no reasoning-effort levels`
            : `${resolved.agent} accepts only ${levels.map((level) => level.id).join(', ')}`),
      );
      resolved = { ...resolved, effort: undefined };
    }
  }
  if (resolved.modelParameters) {
    // Bounded in count and value length through the SAME sanitizer the chat
    // path applies to a run's stored settings — an imported workflow arrives
    // as YAML the user could have hand-edited, and without this its node
    // parameters reached the turn with no cap at all.
    resolved = {
      ...resolved,
      modelParameters: sanitizeModelParameters(resolved.modelParameters),
    };
  }
  return resolved;
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
/** The agents a trigger feeds — where a run's seed and every user message go. */
function triggerFedAgentIds(
  nodes: Workflow['nodes'],
  edges: Workflow['edges'],
): Set<string> {
  const { producersOf } = buildEdgeMaps(nodes, edges);
  const kindOf = new Map(nodes.map((node) => [node.id, node.kind]));
  return new Set(
    nodes
      .filter(
        (node) =>
          node.kind === 'agent' &&
          [...(producersOf.get(node.id) ?? [])].some(
            (id) => kindOf.get(id) === 'trigger',
          ),
      )
      .map((node) => node.id),
  );
}

@Injectable()
export class GraphExecutorService
  implements OnModuleInit, BeforeApplicationShutdown
{
  private readonly logger = new Logger(GraphExecutorService.name);

  /**
   * Set once the daemon has begun shutting down, BEFORE anything reaps a
   * turn — the executor twin of `ChatService`'s flag, and for its reason.
   *
   * The reap happens in `onApplicationShutdown`, which Nest runs only after
   * every `beforeApplicationShutdown`: `ProcessRegistry` cancels each run's
   * aggregate handle and `AgentSessionRegistry` closes each node's kept
   * process. Either way the walk rolled up `cancelled` (or `failed`, when a
   * process was closed under its turn first), and the task board read quitting
   * the app as the user stopping the card. A pass that ends that way without
   * anyone having pressed Stop is left `running`, for the next boot's
   * {@link reconcileOrphanedRuns} to close as interrupted.
   */
  private shuttingDown = false;

  beforeApplicationShutdown(): void {
    this.shuttingDown = true;
  }

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

  /**
   * The runs being walked right now, each with the one way a follow-up can
   * reach its agents while they are live — see {@link sendMessage}.
   */
  private readonly liveRuns = new Map<string, LiveRunControl>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly pullRequests: PullRequestCaptureService,
    private readonly itemDao: ItemDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly callContextDao: CallContextDao,
    private readonly bus: AgentEventBus,
    private readonly registry: ProcessRegistry,
    private readonly sessions: AgentSessionRegistry,
    private readonly approvals: ApprovalRegistry,
    private readonly adapters: AgentAdapterRegistry,
    private readonly callTokens: CallTokenRegistry,
    private readonly callBroker: CallBroker,
    private readonly skillHarvest: SkillHarvestStore,
    private readonly mcpHarvest: McpHarvestStore,
    private readonly store: WorkflowStoreService,
    private readonly runWorkflows: RunWorkflowService,
    private readonly teardown: RunTeardownService,
    private readonly groups: RunGroupsService,
    @Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo,
    private readonly partials: PartialStreamService,
    private readonly attachments: AttachmentStoreService,
    private readonly seqs: ItemSeqAllocator,
    /**
     * The page tool (`show_artifact`) for workflow agents. Optional only so the
     * executor's specs, which construct it positionally, need not supply it.
     */
    @Optional() private readonly artifacts?: ArtifactBroker,
    @Optional() private readonly artifactStore?: ArtifactStoreService,
    @Optional() parallelism?: number,
  ) {
    this.parallelism = parallelism ?? MAX_PARALLEL_AGENTS;
  }

  /**
   * The size of EACH of a run's two concurrency pools, defaulting to what the
   * machine affords ({@link MAX_PARALLEL_AGENTS}).
   *
   * - DAG nodes: a wide level would otherwise spawn every ready node at once.
   *   Ready nodes past the cap stay queued, and each settling node re-enters
   *   schedule(), which launches them as slots free up.
   * - Callee sub-turns: a pool SEPARATE from the nodes', because a sync caller
   *   keeps its node slot while blocked on its callee, so one shared pool
   *   would deadlock a full level of sync callers (every slot held by a
   *   caller, none left for their callees).
   *
   * A constructor argument purely as a TEST SEAM, on
   * `AgentSessionRegistry`'s `ceiling` terms: the specs pin a width so a
   * queueing case means the same thing on a 16GB box and a 128GB one.
   */
  private readonly parallelism: number;

  /** Each run's artifact publishers, disposed when the run is deleted. */
  private readonly artifactDisposers = new Map<string, (() => void)[]>();

  /**
   * What to do when one of a LIVE run's sessions is closed by something other
   * than that run's own teardown — keyed by the session key it was opened
   * under, and consumed by the first close.
   *
   * The registry closes a kept process on its own account (it went unused,
   * the ceiling needed its slot, it went stale), and every delegate running
   * inside that process dies with it. `ChatService` states that ending for a
   * chat, but it cannot for a workflow run: the key it is handed is this
   * executor's composite one, and it must not write into a run whose rows are
   * numbered by this executor's own counter. So the executor listens for its
   * own keys.
   */
  private readonly sessionClosers = new Map<string, () => void>();

  /**
   * The summary an automatic CARRIED compaction owes the next turn on one
   * session key — a CLI whose compaction geniro performs itself
   * (`AgentGeniroCommand.replacesSession`) — and whose presence makes that turn
   * open a fresh session rather than resume the one it replaced. Per KEY
   * because a node's own conversation and each call conversation are compacted
   * apart.
   *
   * In memory: after a restart the summary is gone and the node resumes its
   * old session, which is intact — the conversation is merely not compacted.
   */
  private readonly carriedSummaries = new Map<string, string>();

  /**
   * Per session key, the context a conversation held when it was first
   * measured after an automatic compaction ('pending' until then) — the node
   * twin of `ChatService.compactionBaselines`; see `autoCompactDue`.
   */
  private readonly compactionBaselines = new Map<string, number | 'pending'>();

  /**
   * The conversations whose `running` an OFF-TURN stretch wrote, and what
   * each node's badge is handed back to when that stretch ends.
   *
   * A turn's terminal line ends what the AGENT was saying; the process is
   * kept, and it routinely opens a further turn of its own when work it
   * backgrounded reports back — a timer it set, a build it started. Those
   * rows have always been written (`onOffTurnEvent`); nothing said the node
   * was WORKING again, so the transcript grew with no live row at the end of
   * it and the node's card read `completed` over work in progress. REPORTED
   * as "он продолжил, я не вижу, что он работает… он просто что-то делает,
   * но без статуса".
   *
   * The graph's half of `ChatService`'s `offTurnRuns`, and the same shape for
   * the same reason: the status to restore has to be REMEMBERED, since only
   * a `running` this stretch wrote is this stretch's to take back.
   *
   * Keyed by SESSION KEY rather than by node, because that is the grain of
   * the thing producing the events — one kept process — and a callable node
   * holds its own conversation and one per call it serves at once. Keyed by
   * node, two concurrent stretches would share one entry and the second
   * would write a `running` the restore never balances.
   *
   * SERVICE-scoped rather than per pass, because the process is: a stretch an
   * earlier pass's process opened is ended by the next turn on that process,
   * and that turn is routinely started by a LATER pass. Per pass, the later
   * pass's `persistTurnStart` looked in an empty map and the stretch's
   * `running` was never answered — measured on run `b98d7f8c`, where the
   * Researcher's call-3 stretch outlived call-5 (which continued it from the
   * next pass) and an empty `RESEARCHER · Whittling…` block stood at the end of
   * the transcript.
   */
  private readonly offTurnNodes = new Map<
    string,
    { nodeId: string; callId: string | null; restoreTo: NodeOutcome }
  >();

  /**
   * How many detached commands and background sub-agents each workflow run
   * still has out — the chat path's own counter (`BackgroundWorkCounts`),
   * recorded from this executor's event sinks. A workflow run is listed in the
   * same sidebar as a chat and reported 0 for both figures, so its badge could
   * never reach the held state and its shelf never counted a delegate launched
   * earlier than the loaded page.
   */
  private readonly backgroundWork = new BackgroundWorkCounts((runId, patch) =>
    this.bus.publishRunStatus({ runId, status: null, ...patch }),
  );

  /**
   * Per run, the trigger-fed agents inside a turn right now — what
   * `RunWire.rootsWorking` counts. Service-scoped rather than inside the walk
   * because the runs LISTING answers it too.
   */
  private readonly workingRoots = new Map<string, Set<string>>();

  private setRootWorking(
    runId: string,
    nodeId: string,
    on: boolean,
    announce = true,
  ): void {
    const roots = this.workingRoots.get(runId) ?? new Set<string>();
    if (roots.has(nodeId) === on) {
      return;
    }
    if (on) {
      roots.add(nodeId);
      this.workingRoots.set(runId, roots);
    } else {
      roots.delete(nodeId);
      if (roots.size === 0) {
        this.workingRoots.delete(runId);
      }
    }
    if (announce) {
      this.bus.publishRunStatus({
        runId,
        status: null,
        rootsWorking: roots.size,
      });
    }
  }

  /**
   * Mark a pass's roots working BEFORE its `running` is announced: a message
   * arriving between that status and the root's turn starting would otherwise
   * read the Manager as idle and bounce off "the workflow is still starting".
   */
  private markRootsStarting(runId: string, workflow: Workflow): void {
    for (const nodeId of triggerFedAgentIds(workflow.nodes, workflow.edges)) {
      this.setRootWorking(runId, nodeId, true);
    }
  }

  onModuleInit(): void {
    // Every way a run is destroyed announces it here — this executor's own
    // delete and the archive sweep's shared teardown alike — so the per-key
    // compaction facts are dropped whichever path took the run.
    this.bus.allDeleted().subscribe((runId) => {
      this.forgetCompactions(runId);
      this.workingRoots.delete(runId);
      this.disposeArtifactPublishers(runId);
      // `deleteRun` forgets these itself; the archive sweep reaches this run
      // only through the shared teardown, so without this line a swept run's
      // detached commands stayed counted for the life of the daemon.
      this.backgroundWork.forget(runId);
    });
    this.sessions.onClosed((key) => {
      const closer = this.sessionClosers.get(key);
      if (closer) {
        this.sessionClosers.delete(key);
        closer();
      }
    });
    this.callBroker.useResetWakeHooks({
      save: (runId, wakes) => this.saveResetWakes(runId, wakes),
      wakeRestoredRun: (runId, wake) => {
        void this.wakeRestoredRun(runId, wake);
      },
      note: (runId, nodeId, payload) => {
        void this.noteOnRun(runId, nodeId, payload);
      },
    });
  }

  /**
   * The chain every write of a run's promised continues goes through, so two
   * saves in one tick land in the order they were made — the newest list is
   * the whole truth, and a reordered pair would leave the older one standing.
   */
  private resetWakeWrites: Promise<void> = Promise.resolve();

  /**
   * File a run's promised continues on its row, and tell every client — the
   * composer's "continues at" line is read off the row, and nothing else would
   * refresh it between full listings.
   */
  private saveResetWakes(runId: string, wakes: PersistedResetWake[]): void {
    this.resetWakeWrites = this.resetWakeWrites
      .then(async () => {
        await this.runDao.setResetWakes(
          runId,
          wakes.length === 0 ? null : JSON.stringify(wakes),
          this.em.fork(),
        );
        this.bus.publishRunStatus({
          runId,
          status: null,
          resetWakes: resetWakesWire(wakes),
        });
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `run ${runId}: could not record its usage-limit continues: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /** A transcript row on a run no pass is writing through right now. */
  private async noteOnRun(
    runId: string,
    nodeId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const em = this.em.fork();
      await this.persist(
        em,
        runId,
        nodeId,
        await this.seqs.reserve(runId),
        'system',
        null,
        payload,
      );
    } catch (err) {
      this.logger.warn(
        `run ${runId}: could not write a usage-limit note: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Arm again every continue a run's row says geniro promised before this
   * daemon started — called once at boot, after the schema sync.
   *
   * Without it a restart in the hours a team waits on a usage limit dropped
   * the promise the agents were told to wait for, and nothing said so.
   */
  async rehydrateResetWakes(): Promise<void> {
    const em = this.em.fork();
    for (const run of await this.runDao.listRunsWithResetWakes(em)) {
      // A shelved run is inert, so its promise will never be kept — and the
      // row would go on saying it will, to whoever puts the run back.
      if (run.archivedAt !== null) {
        this.saveResetWakes(run.id, []);
        continue;
      }
      this.callBroker.restoreResetWakes(
        run.id,
        readPersistedResetWakes(run.resetWakes),
      );
    }
  }

  /**
   * Call off every continue promised to one run, on the user's own press.
   *
   * A row still naming continues nothing holds — an archived run's, whose
   * promise was never armed again — is cleared too, so the line promising one
   * goes away when it is pressed rather than lingering over nothing.
   */
  async cancelResetWakes(runId: string): Promise<ResetWakesCancelled> {
    const run = assertWorkflowRun(
      await this.runDao.getById(runId, this.em.fork()),
      runId,
    );
    const cancelledCallIds = this.callBroker.cancelResetWakes(runId);
    if (cancelledCallIds.length === 0 && run.resetWakes !== null) {
      this.saveResetWakes(runId, []);
    }
    return { cancelledCallIds };
  }

  /**
   * The reset has come for a promise a restart carried over, on a run no pass
   * has registered since: walk the run again with the continue as its seed.
   *
   * Only a promise to the run's TRIGGER-FED agents can be kept this way — the
   * walk is what reaches them, and it is the ordinary case (the Manager whose
   * Engineer hit the limit). A promise to an agent that only answers inside a
   * call has no turn a walk could open, and a run whose walk would ALSO start
   * agents that were not waiting cannot be walked for it either — both are
   * SAID instead of kept, with what to do about it.
   */
  private async wakeRestoredRun(
    runId: string,
    wake: PersistedResetWake,
  ): Promise<void> {
    const ids = wake.owners.flatMap((owner) =>
      owner.calls.map((call) => call.callId),
    );
    const unreachable = async (why: string): Promise<void> => {
      for (const owner of wake.owners) {
        await this.noteOnRun(runId, callerNodeOf(owner.owner), {
          severity: 'info',
          message: `The usage limit reset (${wake.resetsAt}), but ${why} — send this agent a message to pick up ${owner.calls.map((call) => call.callId).join(', ')}.`,
          resetWake: {
            phase: 'unreachable',
            instant: wake.instant,
            callIds: owner.calls.map((call) => call.callId),
          },
        });
      }
    };
    try {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      if (
        run === null ||
        run.workflowId === null ||
        run.archivedAt !== null ||
        run.status === 'cancelled'
      ) {
        return;
      }
      const workflow = await this.runWorkflows.workflowOf(
        assertWorkflowRun(run, runId),
        em,
      );
      const roots = new Set(triggerFedAgentIds(workflow.nodes, workflow.edges));
      if (
        !wake.owners.every(
          (owner) =>
            callerConversationOf(owner.owner) === null &&
            roots.has(owner.owner),
        )
      ) {
        await unreachable(
          'geniro was restarted while it waited and this agent only answers inside a call',
        );
        return;
      }
      // A walk opens a turn on EVERY agent it schedules: each trigger-fed one
      // is handed the continue, and each downstream one re-runs on what its
      // producers say next. So it keeps this promise only when the agents it
      // would start are exactly the ones that were waiting — otherwise geniro
      // would start work on its own that nobody asked for.
      const onDemand = onDemandNodeIds(workflow.nodes, workflow.edges);
      const scheduled = workflow.nodes.filter(
        (node) => node.kind === 'agent' && !onDemand.has(node.id),
      );
      const owners = new Set(wake.owners.map((owner) => owner.owner));
      if (
        scheduled.length !== owners.size ||
        !scheduled.every((node) => owners.has(node.id))
      ) {
        await unreachable(
          'geniro was restarted while it waited, and starting the run again would also start agents that were not waiting',
        );
        return;
      }
      await this.walkAgain(
        em,
        assertWorkflowRun(run, runId),
        wake.owners
          .map((owner) => resetWakePrompt(wake.resetsAt, owner.calls))
          .join('\n\n'),
        [],
        {
          severity: 'info',
          message: `The usage limit reset (${wake.resetsAt}) — continuing ${ids.join(', ')}.`,
          resetWake: {
            phase: 'fired',
            instant: wake.instant,
            callIds: ids,
          },
        },
      );
    } catch (err) {
      this.logger.warn(
        `run ${runId}: could not continue after the usage-limit reset: ${err instanceof Error ? err.message : String(err)}`,
      );
      await unreachable('the run could not be started again');
    }
  }

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
    announce: RunStatusAnnounce = {},
  ): Promise<void> {
    await writeRunStatus(
      { runDao: this.runDao, bus: this.bus },
      em,
      runId,
      status,
      announce,
    );
  }

  /**
   * The run-start composition (library lookup → DAG launch) lives in the
   * service layer so the controller stays one-call and a future run-start
   * guard cannot be bypassed from the route.
   */
  async startRunBySlug(
    slug: string,
    input: Omit<StartWorkflowRunInput, 'slug' | 'workflow'>,
  ): Promise<RunWire> {
    const { workflow } = await this.store.get(slug);
    return this.startRun({ ...input, slug, workflow });
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
    // Resolved HERE rather than per turn, for the same two reasons `cwd` is:
    // a bad config directory is a configuration mistake, so refusing the run
    // names it once up front instead of failing one node halfway through the
    // graph — and the CANONICAL path is what the turn must spawn with, since
    // that is what was actually checked. The CLI itself would say nothing: it
    // ignores an unusable --plugin-dir silently (probe-verified), which reads
    // as "this node has no MCP servers".
    const { workflow, dropped } = withResolvedNodeSettings(
      input.workflow,
      (kind) => this.adapterFor(kind),
    );
    await this.validateWorkflowModels(workflow);

    // Which sidebar group claims this run — by the WORKFLOW first, which is the
    // rule a graph exists for: one team graph runs over a dozen repositories,
    // so no folder names its runs. Resolved here for the reason the chat
    // service resolves its own here: this is the one place a workflow run row
    // is created, so the rule cannot be missed by a second caller.
    // A caller that names one WINS, and only a task run does: its project's
    // group is a deliberate answer about where this run belongs, where the
    // rule below is a guess made from a folder the run does not work in. An
    // explicit null is a caller saying "no group", which is also an answer —
    // hence `!== undefined` rather than a `??` that would re-resolve it.
    const groupId =
      input.groupId !== undefined
        ? input.groupId
        : await this.groups.resolveAutoGroupId({
            cwd,
            workflowId: input.slug,
          });
    const em = this.em.fork();
    const run = await this.runDao.create(
      {
        workflowId: input.slug,
        // The graph as it is NOW, kept with the run: a later edit of the
        // library workflow must not reach this run (`Run.workflowSnapshot`).
        workflowSnapshot: workflowSnapshotOf(input.workflow),
        groupId,
        status: 'running',
        agentKind: null,
        cwd,
        model: null,
        // Snapshotted at run start, exactly as a chat does it — blank
        // normalizes to null so a cleared box and an untouched one are one
        // state. Every node of this run then composes the same text.
        customInstructions: input.customInstructions?.trim() || null,
        taskInstructions: input.taskInstructions?.trim() || null,
        agentOptions: writeAgentOptions(input.agentOptions),
        // NOT the workflow's name. A stamped title reads as "this run has been
        // named", which is what kept `ChatTitleService` off workflow runs
        // entirely — so every run of one workflow carried the identical row and
        // the sidebar said which WORKFLOW three times and which TASK not once
        // (reported as "title generation should work for workflow as well").
        // Left null, `title === null` means unnamed here exactly as it does for
        // a chat, and the seed prompt names it a moment later. Nothing is
        // nameless in between: the renderer's own `runLabel` already falls back
        // to the workflow's name for an untitled workflow run, which is also
        // where that name now lives permanently — as the row's label chip.
        //
        // A CALLER may still name one, and exactly one does: a task run, whose
        // card carries a title a person wrote. That is the opposite of the
        // stamp this null exists to prevent — it names the WORK rather than
        // restating which workflow ran it.
        title: input.title?.trim() || null,
        taskId: input.taskId ?? null,
        taskIdentifier: input.taskIdentifier ?? null,
      },
      em,
    );
    if (!this.registry.tryClaim(run.id)) {
      throw new ConflictException('RUN_BUSY', 'run is already executing');
    }
    // Call tokens are minted per caller node inside drive() (once the call
    // edges are known); nothing to revoke here yet — the catch keeps the
    // revokeRun call for symmetry with the settle path.
    let seed: { stored: AttachmentWire[]; turnImages: TurnImage[] };
    try {
      seed = this.storeImages(run.id, input.images ?? []);
      for (const node of input.workflow.nodes) {
        // A node that never runs gets no state row at all. `pending` is a
        // promise that something will happen to it, and an instruction block
        // would wear that chip for the life of the run without ever leaving it.
        if (isNonExecutableNode(node)) {
          continue;
        }
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
    this.markRootsStarting(run.id, workflow);
    this.drive(
      em,
      run.id,
      workflow,
      {
        cwd,
        seedPrompt: input.prompt,
        customInstructions: run.customInstructions,
        taskInstructions: run.taskInstructions,
        agentOptions: readAgentOptions(run.agentOptions),
        resumeSessions: new Map(),
        nodeWindows: new Map(),
        callSeed: null,
        seedPersisted: false,
        seedImages: seed.turnImages,
        seedAttachments: seed.stored,
      },
      dropped,
    );

    return runToWire(
      run,
      null,
      null,
      0,
      null,
      0,
      0,
      0,
      this.workingRoots.get(run.id)?.size ?? 0,
    );
  }

  async cancel(runId: string): Promise<{ cancelled: boolean }> {
    const em = this.em.fork();
    // Kind-guarded mirror of ChatService.cancel (shared assert — the two
    // cancels converge on one registry key) + the 404 the chat siblings return.
    assertWorkflowRun(await this.runDao.getById(runId, em), runId);
    return { cancelled: this.registry.cancel(runId) };
  }

  /**
   * A follow-up message for a workflow run — handed to the agents its trigger
   * feeds, as though the trigger had fired again with this text.
   *
   * REPORTED as "i should be able to add message for workflow. In this case it
   * will just go to same trigger": the composer of a workflow run was disabled
   * outright, so a run could only be followed up by starting another that
   * remembered nothing of this one.
   *
   * Two shapes, decided by whether the run is still being walked. A LIVE run
   * holds those agents' processes, so the message joins the conversation each
   * one is in (`deliverFollowUp`, inside `driveResolved`). A SETTLED run is
   * walked again from its trigger with this message as the seed, every node
   * resuming its own earlier session — the same graph and the same
   * conversations, one more pass.
   */
  async sendMessage(
    runId: string,
    text: string,
    images: SendMessageImage[] = [],
  ): Promise<ItemWire> {
    const em = this.em.fork();
    const run = await this.assertRunTakesMessage(em, runId, text, images);
    const live = this.liveRuns.get(runId);
    if (live) {
      const item = await live.deliver(text, images);
      if (item !== null) {
        return item;
      }
    }
    return this.walkAgain(em, run, text, images);
  }

  /** A message from the user straight to the callee of one running call. */
  async sendCallMessage(
    runId: string,
    nodeId: string,
    callId: string,
    text: string,
    images: SendMessageImage[] = [],
  ): Promise<ItemWire> {
    await this.assertRunTakesMessage(this.em.fork(), runId, text, images);
    const live = this.liveRuns.get(runId);
    if (!live) {
      throw callNotRunning();
    }
    return live.deliverToCall(nodeId, callId, text, images);
  }

  /** The refusals every message into a workflow run shares, whatever it targets. */
  private async assertRunTakesMessage(
    em: EntityManager,
    runId: string,
    text: string,
    images: readonly SendMessageImage[],
  ): Promise<WorkflowRun> {
    if (text.trim() === '' && images.length === 0) {
      throw new BadRequestException(
        'MESSAGE_EMPTY',
        'a message needs words or a picture',
      );
    }
    const run = assertWorkflowRun(await this.runDao.getById(runId, em), runId);
    if (run.archivedAt !== null) {
      throw new ConflictException(
        'RUN_ARCHIVED',
        'this run is archived — unarchive it to send a message',
      );
    }
    return run;
  }

  /**
   * Walk a SETTLED run again from its trigger, with `text` as the seed.
   *
   * The claim is what a second follow-up, a delete or a cancel is refused
   * against, exactly as for a new run. A run whose last pass is still tearing
   * down holds it for a moment longer, which is a RUN_BUSY the renderer queues
   * on rather than an error.
   */
  private async walkAgain(
    em: EntityManager,
    run: WorkflowRun,
    text: string,
    images: SendMessageImage[],
    seedRow: Record<string, unknown> | null = null,
  ): Promise<ItemWire> {
    if (!this.registry.tryClaim(run.id)) {
      throw new ConflictException(
        'RUN_BUSY',
        'this run is still finishing — your message goes out once it has',
      );
    }
    let pass: Awaited<ReturnType<GraphExecutorService['prepareNextPass']>>;
    try {
      pass = await this.prepareNextPass(em, run, text, images, seedRow);
    } catch (err) {
      this.registry.release(run.id);
      throw err;
    }
    if (!this.registry.canStart(run.id)) {
      this.registry.release(run.id);
      await this.setRunStatus(em, run.id, 'failed');
      throw new ConflictException(
        'RUN_STOPPING',
        'daemon shutdown started before the workflow could continue',
      );
    }
    this.drive(em, run.id, pass.workflow, pass.context, pass.dropped);
    return pass.item;
  }

  /**
   * Everything a further pass needs before its walk starts.
   *
   * The workflow is the run's OWN copy, taken when it started — never the
   * library as it is now. Asked for as "old workflows chats should not be
   * changed if i change current workflow": an edit made since is what the next
   * RUN of it runs, not what this one continues with. A run made before runs
   * kept a copy is frozen on this first read (`RunWorkflowService`). Each
   * node's recorded CLI session is collected so it can
   * resume, and the message row is written here rather than by the walk,
   * because the route answers with it.
   */
  private async prepareNextPass(
    em: EntityManager,
    run: WorkflowRun,
    text: string,
    images: SendMessageImage[],
    /**
     * The row to write in place of the user's message, for a pass GENIRO
     * starts (a promised continue) — the agents are handed `text` either way,
     * but the transcript must not show geniro's words as the user's.
     */
    seedRow: Record<string, unknown> | null = null,
  ): Promise<{
    workflow: Workflow;
    dropped: DroppedNodeSetting[];
    context: RunContext;
    item: ItemWire;
  }> {
    if (!run.cwd) {
      throw new BadRequestException(
        'RUN_NOT_CONFIGURED',
        'run is missing a working directory',
      );
    }
    const stored = await this.runWorkflows.workflowOf(run, em);
    validateWorkflowGraph(stored.nodes, stored.edges);
    validateRunnableGraph(stored.nodes, stored.edges);
    computeRunOrder(stored.nodes, stored.edges);
    const cwd = resolveValidCwd(run.cwd);
    const { workflow, dropped } = withResolvedNodeSettings(stored, (kind) =>
      this.adapterFor(kind),
    );
    await this.validateWorkflowModels(workflow);
    const resumeSessions = new Map<string, string>();
    const nodeWindows = new Map<string, number>();
    const states = await this.nodeStateDao.listByRun(run.id, em);
    for (const state of states) {
      if (state.agentSessionId) {
        resumeSessions.set(state.nodeId, state.agentSessionId);
      }
      if (state.contextWindowTokens !== null && state.contextWindowTokens > 0) {
        nodeWindows.set(state.nodeId, state.contextWindowTokens);
      }
    }
    // The broker's call state is in memory and died with whichever daemon ran
    // the earlier pass; the transcript is what survived. Without this the
    // pass started over at `call-1` — colliding with the rows already there —
    // and every conversation the earlier pass had built was unreachable.
    const callSeed = readCallSeed(
      await this.itemDao.callRecordRows(run.id, em),
    );
    // Every node the DAG schedules starts the pass pending again, as it did the
    // first — one added to the workflow since included, which has no row yet.
    //
    // A CALL-ONLY node that already has a row keeps it. It is never scheduled,
    // so `pending` there promised a turn no pass would give it, and it erased
    // how its last call ended: REPORTED as a Researcher card reading `pending`
    // beside `106 tools` and a context ring, a day after its calls completed.
    const onDemand = onDemandNodeIds(workflow.nodes, workflow.edges);
    const hasRow = new Set(states.map((state) => state.nodeId));
    for (const node of workflow.nodes) {
      if (onDemand.has(node.id) && hasRow.has(node.id)) {
        continue;
      }
      if (!isNonExecutableNode(node)) {
        await this.nodeStateDao.setStatus(
          run.id,
          node.id,
          { status: 'pending' },
          em,
        );
      }
    }
    const { stored: storedImages, turnImages } = this.storeImages(
      run.id,
      images,
    );
    const item = await this.persist(
      em,
      run.id,
      null,
      await this.seqs.reserve(run.id),
      seedRow === null ? 'message' : 'system',
      seedRow === null ? 'user' : null,
      seedRow ?? messagePayload(text, storedImages),
    );
    this.markRootsStarting(run.id, workflow);
    await this.setRunStatus(em, run.id, 'running');
    return {
      workflow,
      dropped,
      item,
      context: {
        cwd,
        seedPrompt: text,
        customInstructions: run.customInstructions,
        taskInstructions: run.taskInstructions,
        agentOptions: readAgentOptions(run.agentOptions),
        resumeSessions,
        nodeWindows,
        callSeed,
        seedPersisted: true,
        seedImages: turnImages,
        seedAttachments: [],
      },
    };
  }

  /**
   * Save a follow-up's pictures under the run, the way a chat's are saved: the
   * rows go in the message payload, the paths go to the CLI.
   */
  private storeImages(
    runId: string,
    images: SendMessageImage[],
  ): { stored: AttachmentWire[]; turnImages: TurnImage[] } {
    const stored = images.map((image) =>
      this.attachments.save(runId, image.mediaType, image.data),
    );
    return {
      stored,
      turnImages: stored.map((attachment) => ({
        path: this.attachments.pathOf(runId, attachment.id),
        mediaType: attachment.mediaType,
      })),
    };
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
      const purged = await this.teardown.purge(
        em,
        runId,
        this.registry.settled(runId),
      );
      this.backgroundWork.forget(runId);
      this.workingRoots.delete(runId);
      return purged;
    } finally {
      // The call surface dies with the run even if the purge threw half-way:
      // leaving it registered would let a child that outlived its run dispatch
      // into rows that are already (partly) gone.
      this.callBroker.unregisterRun(runId);
      this.disposeArtifactPublishers(runId);
      this.deleting.delete(runId);
    }
  }

  /** Drop a run's page publishers — every way a run is destroyed calls this. */
  private disposeArtifactPublishers(runId: string): void {
    for (const dispose of this.artifactDisposers.get(runId) ?? []) {
      dispose();
    }
    this.artifactDisposers.delete(runId);
  }

  /**
   * Give each agent node of this pass geniro's PAGE tool (`show_artifact`),
   * the one a chat has had since the family existed. Re-registered every pass,
   * which the broker's identity-checked disposers make safe, and deliberately
   * NOT disposed at the pass's end: a kept process goes on working between
   * passes, and its rows are recorded there like any other.
   */
  private registerArtifactPublishers(
    runId: string,
    nodeIds: readonly string[],
    persistItem: (
      nodeId: string | null,
      kind: ItemKind,
      role: string | null,
      payload: unknown,
    ) => Promise<ItemWire>,
    liveCallOf: (nodeId: string) => string | null,
  ): void {
    const broker = this.artifacts;
    const store = this.artifactStore;
    if (broker === undefined || store === undefined) {
      return;
    }
    // The previous pass's publishers go first: each holds that pass's whole
    // scope (its database fork, its queues), and without this every pass of a
    // long-lived run added another set that only a delete would release.
    this.disposeArtifactPublishers(runId);
    const disposers: (() => void)[] = [];
    for (const nodeId of nodeIds) {
      disposers.push(
        broker.register(
          runId,
          nodeId,
          async (artifact: HostArtifact): Promise<HostArtifactOutcome> => {
            const stored = store.publish(runId, artifact);
            if (!stored.ok) {
              return { status: 'rejected', reason: stored.reason };
            }
            const row: HostArtifactRow = {
              artifactId: stored.stored.artifactId,
              version: stored.stored.version,
              title: artifact.title,
              key: stored.stored.key,
              ...(artifact.summary === undefined
                ? {}
                : { summary: artifact.summary }),
            };
            const callId = liveCallOf(nodeId);
            try {
              await persistItem(
                nodeId,
                'show_artifact',
                null,
                callId === null ? row : { ...row, callId },
              );
            } catch (err) {
              // Logged and kept here, on the chat's rule: a persist failure
              // names an absolute database path, and the string returned goes
              // to a model whose provider is off this machine.
              this.logger.error(
                `run ${runId} could not persist an artifact: ${err instanceof Error ? err.message : String(err)}`,
              );
              return {
                status: 'unavailable',
                reason: 'the transcript row could not be written',
              };
            }
            return {
              status: 'published',
              artifactId: stored.stored.artifactId,
              version: stored.stored.version,
            };
          },
        ),
      );
    }
    this.artifactDisposers.set(runId, disposers);
  }

  /** Drop every per-key fact of one run — its keys are `<runId>::…`. */
  private forgetCompactions(runId: string): void {
    const prefix = runSessionKeyPrefix(runId);
    for (const key of [...this.offTurnNodes.keys()]) {
      if (key.startsWith(prefix)) {
        this.offTurnNodes.delete(key);
      }
    }
    for (const key of [...this.carriedSummaries.keys()]) {
      if (key.startsWith(prefix)) {
        this.carriedSummaries.delete(key);
      }
    }
    for (const key of [...this.compactionBaselines.keys()]) {
      if (key.startsWith(prefix)) {
        this.compactionBaselines.delete(key);
      }
    }
  }

  /**
   * Workflow runs, newest first (the Chats page's run picker).
   *
   * `scope` is the chat listing's own, and the sidebar sends the SAME one to
   * both: a workflow run is shelved by `archivedAt` exactly as a chat is, so
   * the two halves of one list have to agree about how much of the archive they
   * are showing.
   */
  async listRuns(scope: ChatListScope = 'active'): Promise<RunWire[]> {
    const em = this.em.fork();
    const runs = await this.runDao.listWorkflowRuns(scope, em);
    // The chat listing's own backfill, on the same terms: incremental and
    // error-swallowing by construction, so this is a `max(seq)` read per run in
    // the steady state and can never fail the listing. It is what recovers a
    // pull request opened while no window was watching — and every one opened
    // before a workflow run was captured at all, since those runs carry a null
    // marker and are read once from the beginning.
    await this.pullRequests.sync(runs, em);
    const previews = await this.itemDao.runPreviews(
      runs.map((run) => run.id),
      em,
    );
    // Same registry the chat list reads: a workflow node parked on an `ask`
    // card blocks its run exactly as a chat's question blocks that chat, and
    // both lists feed the same sidebar.
    return runs.map((run) =>
      runToWire(
        run,
        previews.get(run.id) ?? null,
        this.approvals.awaitingFor(run.id),
        0,
        null,
        this.backgroundWork.shellsOpen(run.id),
        this.backgroundWork.subagentsOut(run.id),
        // The one reading here that a CHAT row can never carry: a workflow
        // agent parked inside `await_agent` is in a turn and producing
        // nothing, and the composer has to know before it queues a message.
        // On the snapshot rather than the announce alone because the wait
        // lasts as long as the callees do — see `RunWire.awaitingCalls`.
        this.callBroker.awaitingCalls(run.id),
        this.workingRoots.get(run.id)?.size ?? 0,
      ),
    );
  }

  /**
   * Tell every window what this run is parked on NOW — the workflow twin of
   * `ChatService.announceAwaiting`, read from the same registry.
   *
   * The runs listing answers `awaiting` per run, but a listing is a SNAPSHOT:
   * a window keeps whatever it last read until an announce moves it. The chat
   * path announces at every transition; this path announced at none, so a
   * listing taken while a node's question was open left the row reading
   * `needs more info` for good after the question was answered. The open
   * thread derives its badge from the transcript (card answered → `running`),
   * the sidebar and the notification rules read the row — so every switch
   * AWAY from the thread flipped it back to waiting and posted "Waiting for
   * your answer" again. REPORTED as a notification that came back each time
   * another thread was opened, over a run the daemon itself reported as
   * `awaiting: null`.
   *
   * `status: null`: the badge's status belongs to whatever settles the run,
   * and an announce that never read the row must not assert one.
   */
  private announceAwaiting(runId: string): void {
    this.bus.publishRunStatus({
      runId,
      status: null,
      awaiting: this.approvals.awaitingFor(runId),
    });
  }

  /** Per-node execution states of one run (node chips + reconnect snapshot). */
  async getNodeStates(runId: string): Promise<NodeStateWire[]> {
    const em = this.em.fork();
    const run = assertWorkflowRun(await this.runDao.getById(runId, em), runId);
    const rows = await this.nodeStateDao.listByRun(runId, em);
    const adapters = this.adapters.all();
    const poolKinds = snapshotPoolKinds(run.workflowSnapshot);
    // Spend over EVERY turn the run wrote, per node, per call and per node's
    // own conversation — the figures a client's loaded window cannot sum.
    const nodeTotals = new Map<string, ChatTotalsWire>();
    // The part of each node's spend run on a CLI that prices its own turns —
    // what a polled bill is added to (`withNodePolledSpend`).
    const selfPriced = new Map<string, ChatTotalsWire>();
    const stampKinds = new Map(rows.map((row) => [row.nodeId, row.agentKind]));
    const mainTotals = new Map<string, ChatTotalsWire>();
    const callTotals = new Map<
      string,
      { nodeId: string; totals: ChatTotalsWire }
    >();
    const addTo = <K>(
      map: Map<K, ChatTotalsWire>,
      key: K,
      figures: UsageFigures,
    ): void => {
      const totals = map.get(key) ?? emptyTotals();
      addUsage(totals, figures);
      map.set(key, totals);
    };
    // The newest model each node's turns named, on the transcript fold's rule:
    // a turn that named none says nothing about a switch.
    const models = new Map<string, string>();
    for (const turn of await this.itemDao.usageRowsWithNode(runId, em)) {
      if (turn.nodeId === null) {
        continue;
      }
      const payload = asRecord(parseJsonColumn(turn.payload));
      const member = turnMemberOf(payload);
      const model = asRecord(payload?.usage)?.contextModel;
      // Member 1's alone: it is drawn beside the node row's window, which
      // another pool member's turn does not write.
      if (member === null && typeof model === 'string' && model.length > 0) {
        models.set(turn.nodeId, model);
      }
      const figures = usageFiguresFrom(payload);
      if (figures === null) {
        continue;
      }
      addTo(nodeTotals, turn.nodeId, figures);
      if (
        !pollsSpendFor(
          adapters,
          member?.agentKind ?? stampKinds.get(turn.nodeId) ?? null,
        )
      ) {
        addTo(selfPriced, turn.nodeId, figures);
      }
      const callId =
        typeof payload?.callId === 'string' ? payload.callId : null;
      if (callId === null) {
        addTo(mainTotals, turn.nodeId, figures);
        continue;
      }
      const call = callTotals.get(callId) ?? {
        nodeId: turn.nodeId,
        totals: emptyTotals(),
      };
      addUsage(call.totals, figures);
      callTotals.set(callId, call);
    }
    // Each call's START as its own row recorded it, keyed by call — what a
    // client whose window opens after that row needs to title the call's card.
    const starts = new Map<
      string,
      {
        nodeId: string;
        start: NonNullable<NodeStateWire['calls'][number]['start']>;
      }
    >();
    for (const row of await this.itemDao.callRecordRows(runId, em)) {
      if (row.kind !== 'call_started') {
        continue;
      }
      const payload = asRecord(parseJsonColumn(row.payload));
      const text = (key: string): string | null =>
        typeof payload?.[key] === 'string' ? payload[key] : null;
      const callId = text('callId');
      const calleeNodeId = text('calleeNodeId');
      if (callId === null || calleeNodeId === null || starts.has(callId)) {
        continue;
      }
      const message = text('message');
      starts.set(callId, {
        nodeId: calleeNodeId,
        start: {
          callerNodeId: text('callerNodeId'),
          title: text('title'),
          message:
            message === null || message.length <= CALL_START_BRIEF_MAX
              ? message
              : `${message.slice(0, CALL_START_BRIEF_MAX)}…`,
          mode: text('mode'),
          thread: text('thread'),
          startedAt: Number.isFinite(row.createdAt?.getTime())
            ? row.createdAt.getTime()
            : null,
        },
      });
    }
    // Grouped by the node that ran each call, so a reconnecting client gets one
    // ring per call thread beside the node's own collapsed figure.
    const callsByNode = new Map<string, NodeStateWire['calls']>();
    const pushCall = (
      nodeId: string,
      call: NodeStateWire['calls'][number],
    ): void => {
      const forNode = callsByNode.get(nodeId) ?? [];
      forNode.push(call);
      callsByNode.set(nodeId, forNode);
    };
    const readings = await this.callContextDao.listByRun(runId, em);
    for (const call of readings) {
      pushCall(call.nodeId, {
        callId: call.callId,
        contextTokens: call.contextTokens,
        contextWindowTokens: call.contextWindowTokens,
        totals: callTotals.get(call.callId)?.totals ?? emptyTotals(),
        start: starts.get(call.callId)?.start ?? null,
      });
      callTotals.delete(call.callId);
      starts.delete(call.callId);
    }
    // A call that has no `call_context` row — it spent without reporting a
    // context reading, or has not reported anything yet — is still owed its
    // spend and its start. Newest first and within the listing's own cap,
    // which bounds what every re-read pays for.
    const unread = [...new Set([...callTotals.keys(), ...starts.keys()])]
      .sort((a, b) => (callNumber(b) ?? 0) - (callNumber(a) ?? 0))
      .slice(0, Math.max(0, CALL_CONTEXT_SNAPSHOT_LIMIT - readings.length))
      .reverse();
    for (const callId of unread) {
      const spent = callTotals.get(callId);
      const started = starts.get(callId);
      pushCall((spent?.nodeId ?? started?.nodeId)!, {
        callId,
        contextTokens: null,
        contextWindowTokens: null,
        totals: spent?.totals ?? emptyTotals(),
        start: started?.start ?? null,
      });
    }
    return rows.map((row) => ({
      runId: row.runId,
      nodeId: row.nodeId,
      status: row.status,
      contextTokens: row.contextTokens,
      contextWindowTokens: row.contextWindowTokens,
      model: models.get(row.nodeId) ?? null,
      calls: callsByNode.get(row.nodeId) ?? [],
      // A polled-spend node's turns carry no price; its polled bill stands for
      // them, beside whatever a self-pricing pool member's turns cost.
      totals: withNodePolledSpend(
        nodeTotals.get(row.nodeId) ?? emptyTotals(),
        selfPriced.get(row.nodeId) ?? emptyTotals(),
        nodePolledSpend(
          row,
          (kind) => pollsSpendFor(adapters, kind),
          poolKinds.get(row.nodeId),
        ),
      ),
      mainTotals: mainTotals.get(row.nodeId) ?? emptyTotals(),
      workedMs: row.workedMs,
      toolCalls: row.toolCalls,
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
          // Written at BOOT — see the chat twin in `ChatService`.
          interrupted: true,
        });
        // The kill took the in-memory registry with it, so no settle path ever
        // swept these — without this the cards come back looking answerable.
        const history = await this.itemDao.getByRun(run.id, -1, em);
        for (const request of unansweredRequests(history)) {
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
        // The renderer reads a node's liveness and a call block's status off
        // the TRANSCRIPT before node_state, so failing the node rows below
        // alone left the card and the call block spinning under a failed run.
        // Settle both where the renderer looks.
        for (const turn of openNodeTurns(history)) {
          await this.persist(em, run.id, turn.nodeId, seq++, 'status', null, {
            nodeId: turn.nodeId,
            status: 'failed',
            ...(turn.callId !== null ? { callId: turn.callId } : {}),
          });
        }
        for (const call of openCalls(history)) {
          await this.persist(
            em,
            run.id,
            call.callerNodeId,
            seq++,
            'call_result',
            null,
            {
              callId: call.callId,
              callerNodeId: call.callerNodeId,
              calleeNodeId: call.calleeNodeId,
              mode: call.mode,
              status: 'error',
              error:
                'CALLEE_FAILED: interrupted — the daemon stopped before the call finished',
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

  private async validateWorkflowModels(workflow: Workflow): Promise<void> {
    const onDemand = onDemandNodeIds(workflow.nodes, workflow.edges);
    const models = new Map<
      string,
      { agent: AgentKind; model: string | null }
    >();
    for (const node of workflow.nodes) {
      if (node.kind !== 'agent' || onDemand.has(node.id)) {
        continue;
      }
      // Callable pools validate on each attempt so an unavailable backup does
      // not prevent failover; required DAG members still gate startup.
      const model = node.model ?? null;
      models.set(JSON.stringify([node.agent, model]), {
        agent: node.agent,
        model,
      });
    }
    await Promise.all(
      [...models.values()].map(({ agent, model }) =>
        this.adapterFor(agent).validateModel(model),
      ),
    );
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
    run: RunContext,
    dropped: DroppedNodeSetting[],
  ): void {
    void (async () => {
      let approvalSupport: ReadonlyMap<AgentKind, InstalledApprovalSupport>;
      try {
        // A node asking a probed mode waits on its CLI's probe: cached per
        // installed binary, so only the first such run on a machine pays the
        // probe turn.
        approvalSupport = await approvalSupportByKind(workflow, (kind) =>
          this.adapterFor(kind),
        );
      } catch {
        // Unknown is NOT a fail — every node runs with its requested mode and
        // any real CLI rejection surfaces loudly in the transcript.
        approvalSupport = new Map();
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
      this.driveResolved(em, runId, workflow, run, approvalSupport, dropped);
    })();
  }

  private driveResolved(
    em: EntityManager,
    runId: string,
    workflow: Workflow,
    run: RunContext,
    approvalSupport: ReadonlyMap<AgentKind, InstalledApprovalSupport>,
    dropped: DroppedNodeSetting[],
  ): void {
    const {
      cwd,
      seedPrompt,
      customInstructions,
      taskInstructions,
      agentOptions,
    } = run;
    const nodes = workflow.nodes;
    const { producersOf } = buildEdgeMaps(nodes, workflow.edges);
    const nodesById = new Map(nodes.map((n) => [n.id, n]));
    // Call-only callees run per CallBroker call — never scheduled, never in
    // the settled denominator (an uncalled one settles 'skipped' at run end).
    const onDemand = onDemandNodeIds(nodes, workflow.edges);
    // Two separate exclusions, and they must not be folded together: an
    // on-demand callee RUNS (just not on the walk) and settles 'skipped' when
    // nothing called it, while an instruction block never runs at all and has
    // no outcome to report.
    const dagNodes = nodes
      .filter(isExecutableNode)
      .filter((n) => !onDemand.has(n.id));
    // The instruction text each agent node is wired to, in NODE-LIST order —
    // the order the YAML file and the builder's own list already put the
    // blocks in, so two blocks on one agent read the same way every run.
    // Every block is sent whole, whatever its length: instruction text carries
    // no size limit anywhere.
    const blocksOf = new Map<string, string[]>();
    for (const source of nodes) {
      if (source.kind !== 'instruction') {
        continue;
      }
      const text = source.instructions.trim();
      if (!text) {
        continue;
      }
      for (const edge of workflow.edges) {
        if (edge.kind !== 'instruction' || edge.from !== source.id) {
          continue;
        }
        const blocks = blocksOf.get(edge.to);
        if (blocks) {
          blocks.push(text);
        } else {
          blocksOf.set(edge.to, [text]);
        }
      }
    }
    const instructionsFor = (nodeId: string): string | null =>
      blocksOf.get(nodeId)?.join(INSTRUCTION_BLOCK_SEPARATOR) ?? null;
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
    // handle, and only `liveSubTurns` holds the run open for them. Keyed by
    // call id; the callee is what a message addressed to that call is filed
    // under, and the conversation is which of the callee's conversations the
    // turn speaks in — what a message meant for that conversation is handed to.
    const subTurns = new Map<
      string,
      {
        handle: AgentTurnHandle;
        callee: WorkflowAgentNode;
        conversationId: string;
      }
    >();
    /**
     * The node a callee CONVERSATION last ran as, keyed by its caller key —
     * the pool member's resolved node for a pooled callee. What a question
     * about that conversation's own CLI (its tool-call deadline, whether a
     * message interrupts it) is answered against; the graph node names only
     * member 1.
     */
    const conversationNodes = new Map<string, WorkflowAgentNode>();
    /**
     * What was said INTO each running call after it started — the caller's
     * `message_agent` and the user's own — so a call its pool hands to the next
     * member carries them, that member starting a conversation of its own.
     */
    const callMessages = new Map<string, string[]>();
    const noteCallMessage = (callId: string, text: string): void => {
      callMessages.set(callId, [...(callMessages.get(callId) ?? []), text]);
    };
    /**
     * Calls a CALLER asked to stop (`cancel_agent`), by call id.
     *
     * A mark rather than only a `handle.cancel()`, because at depth 1 the
     * commonest call worth cancelling has no handle yet: it is queued on the
     * sub-turn slot pool, which a fan-out of five keeps full. `launchCalleeTurn`
     * reads this at the two points it already reads the run's own cancel, so
     * such a call settles `cancelled` without ever spawning a process.
     *
     * Bounded by the per-run turn cap and freed with the run's closure.
     */
    const cancelledCalls = new Set<string>();
    // The agents a trigger feeds — where the seed goes, and where a follow-up
    // goes while the run is live.
    const triggerFed = triggerFedAgentIds(nodes, workflow.edges);
    // Every DAG turn of the pass counts, not only the roots': a message sent
    // while the walk is still under way waits for it, as it always has — only
    // CALLS (never DAG turns) run on past an idle Manager. Going idle during a
    // cancel is recorded silently: an idle announce is what drains the queue,
    // and Stop must never be answered by sending the next message.
    const markRootWorking = (nodeId: string, on: boolean): void => {
      this.setRootWorking(runId, nodeId, on, on || !cancelRequested);
    };
    /**
     * Follow-up turns on agents whose own turn has ended, keyed by node — see
     * `continueNode`. Cancel fans to these as it does to callee sub-turns, and
     * they hold the run open the same way.
     */
    const continuationHandles = new Map<string, AgentTurnHandle>();
    // Validation awaits reserve a launch before a process handle exists.
    const startingDagNodes = new Set<string>();
    const startingContinuations = new Map<
      string,
      { ready: Promise<void>; release: () => void }
    >();
    const reserveContinuation = (nodeId: string) => {
      const reserved = startingContinuations.get(nodeId);
      if (reserved) {
        return reserved;
      }
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const starting = { ready, release };
      startingContinuations.set(nodeId, starting);
      return starting;
    };
    /**
     * The automatic compactions running right now — reached by the run's
     * cancel like every other live turn. See `compactIfDue`.
     */
    const compactionHandles = new Set<AgentTurnHandle>();
    /**
     * The window each node's conversation last reported, in tokens — what the
     * CLI's OWN auto-compaction is given a share of (`turnAutoCompact` below).
     *
     * Per NODE rather than per conversation, and that is exact rather than
     * loose: what is stored is the MODEL's window, which is the same figure for
     * a node's own DAG turn and for every call turn it serves, since they run
     * the same model. `nodeStateDao.rememberContext` is written per node for
     * the same reason. The token COUNT is the per-conversation half and is
     * deliberately not here — nothing in this map is a reading of how full
     * anything is.
     *
     * Seeded from the earlier passes' readings (`RunContext.nodeWindows`), so
     * only a node's first turn in the RUN runs without the flag — geniro's
     * between-turn rule is the only threshold that one turn has.
     */
    const nodeWindows = new Map<string, number>(run.nodeWindows);
    const rememberNodeWindow = (
      nodeId: string,
      window: number | null,
    ): void => {
      if (window !== null && window > 0) {
        nodeWindows.set(nodeId, window);
      }
    };
    /**
     * Nodes whose OWN conversation is being compacted. A follow-up is refused
     * while a node is here rather than delivered into the compaction.
     *
     * A WAKE needs no such guard: the node's turn is still retained while it
     * compacts, so the broker reads its caller as live and wakes nobody, and
     * the wake `drainCaller` issues at the settle is queued behind that settle.
     */
    const compactingNodes = new Set<string>();
    /**
     * The CLI session each node's own turns reported in THIS pass, so a
     * follow-up can still resume the conversation after the registry has
     * reaped the kept process. Callee turns resume per call, not from here.
     */
    const nodeSessionIds = new Map<string, string>();
    /** A follow-up turn failed, so the run must not roll up as a success. */
    let followUpFailed = false;
    /** This pass's `liveRuns` entry — removed only by the pass that set it. */
    let liveControl: LiveRunControl | null = null;
    /**
     * The calls each callee process has served since it was spawned — what its
     * closer closes the stranded work of. One conversation's process is
     * continued by several calls, and a delegate the first launched is still
     * running inside it after the second has taken the next turn.
     */
    const callsBySessionKey = new Map<string, Set<string>>();
    const subTurnSlots = createTurnSemaphore(this.parallelism);
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
    /**
     * Live turns per CONVERSATION (caller key, `utils/caller-key.ts`) — what
     * the broker's liveness question is answered from.
     *
     * Not the node count above, which counts a node's callee turns too: a node
     * whose OWN conversation had ended read as live for as long as any call to
     * it ran, so a question or a result owed to that conversation neither
     * reached it (nothing could be handed to a turn it did not have) nor woke
     * it — and a callee that was itself a caller was woken as the NODE, in a
     * new process with none of the call's context.
     */
    const liveConversations = new Map<string, number>();
    const retainConversation = (caller: string): void => {
      liveConversations.set(caller, (liveConversations.get(caller) ?? 0) + 1);
    };
    /**
     * One conversation's turn has ended: it is live no more, and what its
     * callees left it — a parked question, an uncollected result — is drained
     * to it now (`CallBroker.drainCaller`), each conversation on its own.
     */
    const endConversationTurn = (caller: string): void => {
      const next = (liveConversations.get(caller) ?? 1) - 1;
      if (next > 0) {
        liveConversations.set(caller, next);
        return;
      }
      liveConversations.delete(caller);
      // A message the turn never took reaches the conversation as its next
      // turn's prompt, not inside a wait of this one.
      this.callBroker.forgetUserMessage(runId, caller);
      this.callBroker.drainCaller(runId, caller);
    };
    let cancelRequested = false;
    /**
     * Whether the run's cancel came from somebody ASKING — a Stop, an archive,
     * a delete — rather than from the shutdown reap. Decided by the FIRST
     * cancel, which is the only one the aggregate handle acts on: a Stop
     * pressed a moment before quitting is still the user's, and the reap that
     * follows it changes nothing.
     */
    let stoppedByUser = false;
    /**
     * Whether this pass is ending because the DAEMON is going away rather than
     * because anyone stopped it — see {@link GraphExecutorService.shuttingDown}.
     * Read at the two places a run's own status is written from a walk, and
     * only for an ending other than `completed`: a pass whose every node
     * finished as the shutdown began completed, and says so.
     */
    const endedByShutdown = (status: RunStatus): boolean =>
      status !== 'completed' && this.shuttingDown && !stoppedByUser;
    let runFinished = false;
    let persistenceFailed = false;

    // One serialized write chain for the whole pass: persist-then-emit ordering
    // stays correct while N nodes stream at once. The seq itself comes from the
    // SHARED allocator rather than a counter of this pass's own, because this
    // pass is no longer the run's only writer: its agents' processes outlive
    // it, and what they do between passes is written by the sinks of the pass
    // that spawned them while a later pass may already be writing.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (work: () => Promise<void> | void): void => {
      chain = chain.then(work).catch((err: unknown) => {
        persistenceFailed = true;
        this.logger.error(
          `workflow run ${runId} event handling failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    };

    /** Resolves once every write queued so far has run. */
    const drained = (): Promise<void> =>
      new Promise<void>((resolve) => {
        enqueue(() => resolve());
      });

    const persistItem = async (
      nodeId: string | null,
      kind: ItemKind,
      role: string | null,
      payload: unknown,
    ): Promise<ItemWire> =>
      this.persist(
        em,
        runId,
        nodeId,
        await this.seqs.reserve(runId),
        kind,
        role,
        payload,
      );

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
    const sweepApprovals = (nodeId: string): (() => Promise<void>) =>
      recordUnanswerable(nodeId, this.approvals.sweepNode(runId, nodeId));

    /**
     * The row-writing half of a sweep, for cards already dropped from the
     * registry — shared by the node-wide sweep above and a single turn's own
     * retirement (`beginAgentTurn`'s `retireCards`).
     */
    const recordUnanswerable = (
      nodeId: string,
      swept: ReturnType<ApprovalRegistry['sweepNode']>,
    ): (() => Promise<void>) => {
      // Every settle path sweeps through here, so this one announce is what
      // takes the badge down for all four — a swept card is no longer
      // something the run waits on.
      if (swept.length > 0) {
        this.announceAwaiting(runId);
      }
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

    /**
     * State the ending of the work this run's transcript still declares out:
     * every delegate and — with `withShells` — every detached command, or only
     * what ONE session's process was running when `scope` names it.
     *
     * The process that owed each ending is gone or about to be: a delegate
     * lives inside the CLI process that launched it, and a detached command is
     * that process's own child. Neither of the other writers can say so for a
     * workflow run — `ChatService`'s session-close hook keys by RUN and is
     * handed this executor's per-turn session key, and the shell closes a dying
     * process announces arrive after `runFinished`, where `onOffTurnEvent`
     * drops them.
     *
     * Read from the transcript, so one fold answers both callers, and written
     * through `persistItem`, so the rows take this run's own seq.
     */
    const closeStrandedWork = async (
      scope: { callId: string } | { nodeId: string } | null,
      withShells: boolean,
    ): Promise<void> => {
      const inScope = (unit: {
        nodeId: string | null;
        callId: string | null;
      }): boolean =>
        scope === null ||
        ('callId' in scope
          ? unit.callId === scope.callId
          : unit.callId === null && unit.nodeId === scope.nodeId);
      const closes: {
        event: AgentEvent;
        owner: { nodeId: string | null; callId: string | null };
      }[] = [];
      for (const delegate of strandedDelegates(
        await this.itemDao.subagentInfoRows(runId, em),
      )) {
        if (inScope(delegate)) {
          closes.push({
            event: delegateCloseEvent(delegate.id, 'stopped'),
            owner: delegate,
          });
        }
      }
      if (withShells) {
        for (const shell of strandedShells(
          await this.itemDao.shellRows(runId, em),
        )) {
          if (inScope(shell)) {
            closes.push({ event: shellCloseEvent(shell), owner: shell });
          }
        }
      }
      for (const { event, owner } of closes) {
        // The count comes down with the row that states the ending.
        this.backgroundWork.record(runId, event);
        const mapped = mapEventToItem(event);
        if (mapped) {
          await persistItem(owner.nodeId, mapped.kind, mapped.role, {
            ...(mapped.payload as Record<string, unknown>),
            ...ownerFields(owner),
          });
        }
      }
    };

    let resolveAllDone!: () => void;
    /**
     * The aggregate handle THIS pass registered last — what tells the pass's own
     * registry entry apart from a LATER pass's claim on the same run (see
     * {@link supersededByNextPass}).
     */
    let ownAggregate: AgentTurnHandle | null = null;
    /**
     * Register a fresh aggregate handle for this run — once at the start of the
     * pass, and again each time the run WAKES BACK UP for work its own agents
     * started (see {@link reopenRun}).
     *
     * A handle's `done` is fixed when the handle is built and the registry
     * drops an entry whose `done` has settled, so waking up needs a NEW one:
     * re-using the settled handle would leave the callee turn spawned
     * afterwards reachable by neither Stop nor shutdown — which is exactly the
     * objection `launchCalleeTurn` used to answer by refusing the call.
     *
     * {@link resolveAllDone} is re-assigned with it, so a finalizer that has
     * already run cannot settle the handle its own successor registered.
     */
    const registerAggregate = (): void => {
      const done = new Promise<void>((resolve) => {
        resolveAllDone = resolve;
      });
      const aggregateHandle: AgentTurnHandle = {
        done,
        cancel: () => {
          if (cancelRequested) {
            return;
          }
          cancelRequested = true;
          stoppedByUser = !this.shuttingDown;
          for (const handle of runningHandles.values()) {
            handle.cancel();
          }
          for (const { handle } of subTurns.values()) {
            handle.cancel();
          }
          for (const handle of continuationHandles.values()) {
            handle.cancel();
          }
          for (const handle of compactionHandles) {
            handle.cancel();
          }
          // Nodes that never started settle as cancelled in the next pass.
          enqueue(() => schedule());
        },
        // Approvals route through the ApprovalRegistry per request, not the
        // aggregate — a run-level respond has no single target turn.
        respondApproval: () => false,
        // Same reason: a run fanning out over N nodes has no ONE conversation a
        // follow-up belongs to. A workflow's follow-up goes through
        // `sendMessage`, which hands it to the agents the trigger feeds.
        sendUserMessage: () => false,
        attributableDelegate: () => null,
        setApprovalMode: () => false,
      };
      ownAggregate = aggregateHandle;
      this.registry.register(runId, aggregateHandle);
    };
    registerAggregate();

    /**
     * Whether a LATER pass of this run holds it now — a follow-up message's walk
     * has claimed the registry (or already registered its own handle), so this
     * pass, and the call surface it registered, are about to be replaced.
     *
     * Only meaningful once this pass has finished: until then its own handle is
     * the registry entry and no follow-up can claim over it. A kept process can
     * still reach this pass's call surface in that window, and serving it there
     * was what put two passes on one run — the wake's `register` overwrote the
     * claim, so the follow-up's walk started too, its broker registration
     * replaced the call the wake had minted (`UNKNOWN_CALL` on collection), and
     * Stop reached only the newer handle, leaving the first callee running.
     */
    const supersededByNextPass = (): boolean =>
      runFinished &&
      this.registry.has(runId) &&
      this.registry.runningHandle(runId) !== ownAggregate;

    /**
     * What this run's PASS rolled up to — what the run goes back to once work
     * it woke up for afterwards has drained. Read only while {@link reopened}.
     */
    let passStatus: RunStatus = 'completed';
    /** The run is AWAKE again, for work its own agents started. */
    let reopened = false;
    /**
     * The pass's roll-up while it is being written, so a call arriving in that
     * window waits for it instead of racing it — see {@link reopenRun}.
     */
    let finalizing: Promise<void> | null = null;
    /**
     * A wake's settle while it writes the pass's status back — the twin of
     * {@link finalizing} for {@link settleReopenedIfIdle}, and null when none
     * is in flight.
     */
    let sleeping: Promise<void> | null = null;

    /**
     * Wake the run back up for a call one of its agents makes after the pass
     * has ended.
     *
     * A node's CLI process is KEPT between passes, so a Manager that set itself
     * a timer wakes on its own and dispatches to its team — into a run that had
     * already let go of everything needed to run one. That is why the call used
     * to be refused outright, and the refusal reached the agent as
     * `RUN_NOT_ACTIVE: this run is not accepting agent calls`: REPORTED after a
     * Manager woke on time with three briefs prepared and could not hand out a
     * single one, having spent hours getting them ready.
     *
     * So the refusal becomes a WAKE. The run's own PASS is deliberately
     * untouched — `runFinished` stays true — so a USER's follow-up still walks
     * a fresh pass from the trigger rather than being delivered into a walk
     * that is over, which is the one thing here that already worked.
     *
     * It answers `stopped` for a run that must not wake, and re-reads the row
     * to decide rather than trusting this closure: the call surface now
     * outlives the walk, and an archive stops the run through the registry
     * without this pass ever hearing of it. It answers `superseded` when a
     * follow-up message has claimed the run for its next pass meanwhile
     * ({@link supersededByNextPass}) — decided in the same synchronous stretch
     * as the registration, since the claim lands during the awaits above it.
     */
    const reopenRun = async (): Promise<'awake' | 'stopped' | 'superseded'> => {
      // The roll-up writes this run's terminal status; waking ahead of it puts
      // `running` on the row and has it overwritten a moment later.
      await finalizing;
      // The same for a previous wake going back to sleep, which has already
      // said `reopened = false` and is writing the pass's status. Waking under
      // it registered a handle that settle then resolved as its own — dropping
      // the registry entry of a run with a callee still spawning, so Stop found
      // nothing, a delete waited on nothing and a follow-up could walk a second
      // pass beside it — and its status landed over this wake's `running`. A
      // loop, because the check below must see no settle in flight at the
      // moment it reads `reopened`, and another may have begun while this one
      // was awaited.
      while (sleeping !== null) {
        await sleeping;
      }
      if (cancelRequested || this.deleting.has(runId)) {
        return 'stopped';
      }
      if (reopened) {
        return 'awake';
      }
      const run = await this.runDao.getById(runId, em);
      if (!run || run.archivedAt !== null || run.status === 'cancelled') {
        return 'stopped';
      }
      // Asked again after the read: two calls waking the run at once both got
      // past the check above, and each registered a handle — the first of
      // which nothing would ever settle.
      if (reopened) {
        return 'awake';
      }
      if (cancelRequested || this.deleting.has(runId)) {
        return 'stopped';
      }
      // A follow-up's walk claimed the run during the awaits above. Registering
      // now would overwrite that claim — see `supersededByNextPass`.
      if (supersededByNextPass()) {
        return 'superseded';
      }
      reopened = true;
      registerAggregate();
      // A user's message reaches an AWAKE run through the same control a live
      // pass offers — the wake holds the run's claim, so the walk a settled run
      // takes instead would refuse every message RUN_BUSY for as long as the
      // woken work runs.
      if (liveControl !== null) {
        this.liveRuns.set(runId, liveControl);
      }
      await this.setRunStatus(em, runId, 'running');
      return 'awake';
    };

    /**
     * Put the run back once the work it woke for has drained — the other half
     * of {@link reopenRun}, and the only thing that settles the handle that one
     * registered.
     *
     * Reached through {@link finishRunIfSettled}, which every path already
     * calls after decrementing `liveSubTurns`; a second settle point of its own
     * would be one more place for a path to forget.
     */
    const settleReopenedIfIdle = async (): Promise<void> => {
      if (!reopened || liveSubTurns > 0) {
        return;
      }
      reopened = false;
      // Back to a settled run, whose messages walk a fresh pass.
      if (liveControl !== null && this.liveRuns.get(runId) === liveControl) {
        this.liveRuns.delete(runId);
      }
      // THIS wake's handle, captured before the write — the rule
      // `finishRunIfSettled` follows for the pass's own. `reopenRun` now waits
      // for this settle, so nothing re-assigns `resolveAllDone` under it; the
      // capture is what keeps that true if a second path ever registers one.
      const settleWake = resolveAllDone;
      let slept!: () => void;
      sleeping = new Promise<void>((resolve) => {
        slept = resolve;
      });
      try {
        const status = cancelRequested ? 'cancelled' : passStatus;
        // A wake the shutdown ended leaves the `running` it wrote, on the
        // roll-up's own terms below.
        if (!endedByShutdown(status)) {
          // A wake writes no run-level terminal row, so the open thread's
          // working state is this announce's to end.
          await this.setRunStatus(em, runId, status, {
            noTerminalItem: true,
          });
        }
      } finally {
        // The handle settles even if the write failed, as the pass's own does
        // — otherwise the registry entry outlives the work it stood for.
        settleWake();
        sleeping = null;
        slept();
      }
    };

    const finishRunIfSettled = async (): Promise<void> => {
      // Sub-turns stay OUT of the denominator, but a live one (a
      // fire-and-forget still streaming) holds the run open until it settles.
      if (runFinished) {
        // The PASS is over, so there is nothing here left to roll up — but the
        // run may have woken since for work its own agents started, and this is
        // the one point every path reaches after decrementing `liveSubTurns`.
        await settleReopenedIfIdle();
        return;
      }
      if (settled.size !== dagNodes.length || liveSubTurns > 0) {
        return;
      }
      runFinished = true;
      // A root the pass never got to launch (cancelled while queued) is idle.
      for (const nodeId of triggerFed) {
        markRootWorking(nodeId, false);
      }
      // Captured BEFORE the body: from here on a call can wake the run, and a
      // wake re-assigns `resolveAllDone` to the handle IT registered.
      const settlePass = resolveAllDone;
      let finalized!: () => void;
      // What {@link reopenRun} waits on. `runFinished` is already true, so a
      // call arriving now would otherwise race the roll-up below and have its
      // `running` overwritten by this pass's own terminal status.
      finalizing = new Promise<void>((resolve) => {
        finalized = resolve;
      });
      // EVERY final write is inside the try: the skipped-marking loop, the
      // status roll-up, and the run update must all sit under the finally, or
      // a SQLite failure in the skipped loop would leave runFinished true with
      // the aggregate handle never settling — the registry entry and call
      // token would leak and the run would wedge as `running` forever.
      try {
        // On-demand callees that were never called settle 'skipped' so their
        // chips don't read as pending forever.
        //
        // The node state ALONE, deliberately — no transcript row. It used to
        // write one as well, which the agents panel then said again from this
        // very column, so a run whose manager routed everything to one
        // specialist closed with `− Engineer skipped — never called` and
        // `− Researcher skipped — never called` in the conversation. REPORTED
        // as "он написал, что never called engineer или researcher, и нам не
        // нужно этого писать": a node that was never called has, by
        // construction, nothing to say — those two rows were the whole of its
        // transcript presence — so the row reported an absence of events as
        // though it were one.
        //
        // The distinction is which SURFACE answers which question. The panel
        // lists every node in the graph and what became of it, so "why is
        // Engineer not here" is answered there, permanently, off `node_state`.
        // The transcript is what HAPPENED, and nothing happened.
        //
        // "Never called" is a fact about the RUN, and `calleeTurnCounts` counts
        // this PASS — so a node an earlier pass called, and that this pass
        // simply did not need, was stamped `skipped` over the status its last
        // call ended with. REPORTED on a Dev Team run whose Engineer card read
        // `skipped` beside 24 turns, 2,922 tool calls and eleven hours worked:
        // the user's last message was answered by the Manager alone. Only a
        // node still `pending` — the row a pass writes for a node nothing has
        // run yet — has never been called.
        for (const node of nodes) {
          if (
            !onDemand.has(node.id) ||
            (calleeTurnCounts.get(node.id) ?? 0) > 0
          ) {
            continue;
          }
          const state = await this.nodeStateDao.getByRunNode(
            runId,
            node.id,
            em,
          );
          if (state !== null && state.status !== 'pending') {
            continue;
          }
          await this.nodeStateDao.setStatus(
            runId,
            node.id,
            { status: 'skipped', endedAt: Date.now() },
            em,
          );
        }
        // A delegate or detached command still out at the end of a pass is NOT
        // stranded: its process is kept (see the `finally`), so it is still
        // running and says its own ending when it has one. What dies with a
        // process is written when that process goes, by its closer.
        //
        // A user cancel rolls up cancelled; any other non-completed node (a
        // failure, or a CLI killed externally without cancel()) is a failure —
        // downstream nodes were skipped, so the run must never read as success.
        const anyNotCompleted = [...settled.values()].some(
          (outcome) => outcome !== 'completed',
        );
        const status = cancelRequested
          ? 'cancelled'
          : anyNotCompleted || persistenceFailed || followUpFailed
            ? 'failed'
            : 'completed';
        // Remembered for {@link settleReopenedIfIdle}: a run that wakes for a
        // call its agent makes afterwards goes back to what the WALK rolled up
        // to, never to a fresh `completed` that would paint over a failure.
        passStatus = status;
        if (endedByShutdown(status)) {
          // Nobody stopped this run: the daemon is shutting down, and that is
          // what ended its turns. Neither the status nor the closing
          // `workflow_<status>` row is written — the run stays `running`, and
          // the next boot's reconcile closes it with the `interrupted` error a
          // SIGKILL leaves, which is what the task board reads it as.
          this.logger.log(
            `workflow run ${runId}: pass ended by the daemon shutting down — left running for the next boot to close as interrupted`,
          );
        } else {
          await this.setRunStatus(em, runId, status);
          await persistItem(null, 'turn_complete', null, {
            usage: null,
            stopReason: `workflow_${status}`,
          });
        }
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
        // First, so a follow-up arriving during the teardown below is walked
        // again from the trigger instead of being handed to a process that is
        // being closed.
        if (liveControl !== null && this.liveRuns.get(runId) === liveControl) {
          this.liveRuns.delete(runId);
        }
        // The aggregate handle MUST settle even if the final writes fail, or
        // the ProcessRegistry entry leaks and the run can never be re-driven.
        //
        // The agents' PROCESSES are deliberately left running, as a chat's are
        // between its turns: a reply ends a PASS, not the conversation, and what
        // an agent started in the background — a dev server the user is about
        // to open — lives inside its process. REPORTED as "This site can't be
        // reached" right after a Manager started `web` and `api` and handed over
        // the links: closing every session here killed both the moment its
        // reply settled. The next message reuses each kept process (same key);
        // the registry reaps one that goes unused, never while a detached
        // command is still running; and a delete or archive ends them all
        // (`AgentSessionRegistry.closeRun`). Their closers stay armed, so the
        // endings of what dies with a process are still written when it goes.
        //
        // The call surface OUTLIVES the pass, exactly as the processes above
        // do and for the same reason: a kept Manager wakes on its own when
        // work it backgrounded reports back, and dispatching to its team is
        // the whole of what it wakes up to do. It used to be dropped here, so
        // that call was answered `RUN_NOT_ACTIVE` and the team went unused.
        // `reopenRun` is what makes serving it safe; a later pass REPLACES the
        // registration, and the run's teardown drops it along with the caller
        // tokens — which were already kept for this reason, a kept process
        // presenting the token it spawned with.
        //
        // The live plane's per-node state ends with the pass, exactly as a
        // chat's ends with its turn. The remembered window survives (it
        // describes the model), so a re-run of the same graph is scaled from
        // its first request.
        this.partials.clearRun(runId);
        // THIS pass's handle, captured before the body ran: a call that woke
        // the run meanwhile has registered a handle of its own, and settling
        // that one here would drop a registry entry whose callee is still
        // spawning.
        settlePass();
        finalized();
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
    // Settled once per run, per CLI: a node is judged only by its own CLI's
    // verdict, and a CLI no node asked a probed mode of reads as unprobed.
    const resolveApproval = (node: WorkflowAgentNode): ApprovalResolution =>
      this.adapterFor(node.agent).resolveApprovalMode(
        node.approval,
        approvalSupport.get(node.agent) ?? { supported: {} },
      );

    /**
     * The node's "turn is starting" bookkeeping shared by DAG launches and
     * callee sub-turns: node_state → running, the status item, and the
     * approval-degrade note. A callee sub-turn passes its callId so the
     * renderer can attribute the status to ONE call even when two parallel
     * calls target the same node.
     *
     * It also ENDS an off-turn stretch the same conversation was still
     * carrying — the third of {@link restoreOffTurnNodeBadge}'s endings, and
     * the one that is reached on ACP at all. A continuation's own terminal
     * event never comes there (an agent speaking unprompted is answered by no
     * `session/prompt` reply), and the process is KEPT, so the close could be
     * half an hour away: a `thread:` continuation was handed the very process
     * still holding the badge, the stretch's `running` row was never answered,
     * and the renderer counted that callee as working for good. Measured on
     * run `20a2b92b`: QA's call-8 stretch took the badge at 23:41:50, call-9
     * continued the thread at 23:47:23, and an empty `QA · Forging…` block
     * stood at the end of the transcript long after call-9 completed. A turn
     * of ours starting on the process is proof the stretch is over.
     */
    const persistTurnStart = (
      node: WorkflowAgentNode,
      sessionKey: string,
      callId: string | null = null,
      pool: {
        /** What the row is stamped with — member 1, the node's own settings. */
        stamp: WorkflowAgentNode;
        /** False for a later attempt: the call's first one already said so. */
        announce: boolean;
      } = { stamp: node, announce: true },
    ): void => {
      enqueue(async () => {
        await restoreOffTurnNodeBadge(sessionKey);
        await this.nodeStateDao.setStatus(
          runId,
          node.id,
          // agentKind and model stamp WHAT ran this turn — the terminal mirror
          // must resume against both even after the workflow YAML is edited.
          {
            status: 'running',
            startedAt: Date.now(),
            agentKind: pool.stamp.agent,
            model: pool.stamp.model ?? null,
          },
          em,
        );
        // One `running` row per CALL, balanced by its one ending: an attempt
        // the pool hands on writes no ending, so a later one writes no start.
        if (pool.announce) {
          await persistItem(node.id, 'status', null, {
            nodeId: node.id,
            status: 'running',
            ...(callId ? { callId } : {}),
          });
        }
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
     * Say a node is working again, for an off-turn row that means it is.
     *
     * A workflow node's liveness is read off its `status` ROWS and nothing
     * else: the renderer counts `running` rows against terminal ones
     * (`computeAgentActivity`'s `activeTurns`) and draws its live row from that
     * count, so rows arriving with no `running` above them draw nothing —
     * whatever the RUN's own badge says, which is a different question and is
     * answered by `shellsOpen`. Writing this pair is therefore what makes the
     * stretch visible, and — just as much — what ENDS it, since the terminal
     * row is what takes the count back down.
     *
     * Once per stretch: the map is the CLAIM as well as the memory.
     */
    const takeOffTurnNodeBadge = async (
      sessionKey: string,
      nodeId: string,
      callId: string | null,
    ): Promise<void> => {
      if (this.offTurnNodes.has(sessionKey)) {
        return;
      }
      const status = (await this.nodeStateDao.getByRunNode(runId, nodeId, em))
        ?.status;
      // Only a node whose turn has ENDED has a badge to take — see
      // {@link NODE_OUTCOMES}. A node with no row at all is one this run never
      // started, and is not this stretch's to describe.
      if (status === undefined || !NODE_OUTCOMES.has(status)) {
        return;
      }
      this.offTurnNodes.set(sessionKey, {
        nodeId,
        callId,
        restoreTo: status as NodeOutcome,
      });
      await this.nodeStateDao.setStatus(
        runId,
        nodeId,
        { status: 'running' },
        em,
      );
      await persistItem(nodeId, 'status', null, {
        nodeId,
        status: 'running',
        ...(callId ? { callId } : {}),
      });
    };

    /**
     * Hand a node's badge back when its off-turn stretch ends.
     *
     * Two endings, and neither can stand in for the other: the continuation's
     * own terminal event, and the PROCESS closing — which is the one that owed
     * that event, so once it is gone nothing else could ever take the row down.
     * The chat side learned the same thing the same way
     * (`settleAfterSessionClosed`).
     */
    const restoreOffTurnNodeBadge = async (
      sessionKey: string,
    ): Promise<void> => {
      const held = this.offTurnNodes.get(sessionKey);
      if (held === undefined) {
        return;
      }
      this.offTurnNodes.delete(sessionKey);
      await this.nodeStateDao.setStatus(
        runId,
        held.nodeId,
        { status: held.restoreTo },
        em,
      );
      await persistItem(held.nodeId, 'status', null, {
        nodeId: held.nodeId,
        status: held.restoreTo,
        ...(held.callId ? { callId: held.callId } : {}),
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
     * Nodes handed the MCP endpoint: EVERY call-capable agent, not callers
     * alone — otherwise a callee, and any node of an ordinary run, has none of
     * geniro's own tools at all, and an agent asked for a Geniro artifact
     * writes a real HTML page and opens it in a browser instead. What each
     * node is OFFERED on the endpoint is still decided per request: the call
     * tools need callees, the page tool the publisher below; the board tools
     * go to every holder, under the node's own approval mode.
     */
    const holdsEndpoint = (node: WorkflowAgentNode): boolean =>
      callCapable(node);

    /**
     * The node's MCP grant: every call-capable agent node gets the endpoint
     * (`holdsEndpoint`); what it is offered there depends on what it can use.
     * Null when the server has no bound port yet or the run's token is already
     * revoked.
     */
    const mcpEndpointFor = (
      node: WorkflowAgentNode,
      /**
       * The callee conversation this turn speaks in, or null for the node's
       * own. It is the endpoint's last segment, and so the caller identity the
       * broker keys everything this process calls by (`utils/caller-key.ts`):
       * every conversation of a node is its own process, and a process can
       * only be told apart from its siblings by the address it was given.
       */
      conversationId: string | null = null,
    ): { url: string; token: string; serverName: string } | null => {
      if (!holdsEndpoint(node)) {
        return null;
      }
      const token = this.callTokens.get(runId, node.id);
      const port = this.runtime.port;
      if (token === null || port === null) {
        return null;
      }
      const conversation =
        conversationId === null ? '' : `/${encodeURIComponent(conversationId)}`;
      return {
        url: `http://127.0.0.1:${port}/v1/mcp/${encodeURIComponent(runId)}/${encodeURIComponent(node.id)}${conversation}`,
        token,
        // Per-run — see `AgentTurnInput.mcpEndpoint.serverName` for why.
        serverName: hostMcpServerName(runId),
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
      return `May call (via the call_agent tool; await_agent collects async results):\n${lines.join('\n')}\n${questionLine}\nPrefer async calls: launch them, keep working or end your turn, and you are started again when a call finishes or asks you something — do not sit waiting on a callee while you have other work.\nWhen you learn something that changes a RUNNING call's work — the user corrects what they asked for — send it into that call at once with message_agent(call_id, message) instead of waiting for the call to finish.\nWhen a call has become POINTLESS — its premise refuted, its task withdrawn, or its own output showing it is building the wrong thing — stop it with cancel_agent(call_id, reason) and say so to the user. A slow callee is not that case: check in with await_agent(timeout_ms) instead.`;
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
    const beginAgentTurn = async (
      node: WorkflowAgentNode,
      prompt: string,
      /**
       * A callee turn's identity: its call, the session it resumes when no
       * kept process holds the conversation, and the CONVERSATION it belongs
       * to — the call id its kept process is keyed by (see `sessionKey`).
       */
      callContext?: {
        callId: string;
        resumeSessionId?: string | null;
        conversationId: string;
        /** The callee pool member this turn runs as; absent without a pool. */
        poolMember?: number;
      },
      /**
       * What a node's OWN turn carries beyond its prompt: the session to resume
       * when no kept process holds the conversation, and the pictures a seed
       * or a follow-up came with. A callee's resume rides `callContext`.
       */
      extras: { resumeSessionId?: string | null; images?: TurnImage[] } = {},
    ): Promise<{
      handle: AgentTurnHandle;
      finish: () => NodeTurnResult;
      /**
       * How the turn ended, known the moment its terminal event arrives —
       * {@link finish}'s outcome without waiting for the bookkeeping to drain.
       */
      endedAs: () => NodeOutcome;
      retireCards: () => () => Promise<void>;
    }> => {
      const adapter = this.adapterFor(node.agent);
      await adapter.validateModel(node.model);
      if (
        cancelRequested ||
        !this.registry.canStart(runId) ||
        (callContext !== undefined && cancelledCalls.has(callContext.callId))
      ) {
        throw new Error('Workflow stopped before the agent could launch.');
      }
      // One registry key per CONVERSATION — see the note at `startTurn` below.
      const sessionKey = callContext
        ? callSessionKey(runId, callContext.conversationId)
        : nodeSessionKey(runId, node.id);
      // WHO this turn is, to the call broker: the node, in this conversation.
      const caller = callerKey(node.id, callContext?.conversationId ?? null);
      // An automatic carried compaction replaced this conversation: its summary
      // rides this turn, once, and the session it replaced is not resumed.
      const carried = this.carriedSummaries.get(sessionKey) ?? null;
      this.carriedSummaries.delete(sessionKey);
      /**
       * Put the summary back for a turn that never delivered it — a start that
       * threw, or a turn that ended before its CLI opened a session. Without
       * it the conversation would resume the replaced session with no summary,
       * and measure its pre-compaction size as the new baseline.
       */
      const restoreCarried = (): void => {
        if (carried !== null && !this.carriedSummaries.has(sessionKey)) {
          this.carriedSummaries.set(sessionKey, carried);
        }
      };
      // The newest context reading this turn reported, for auto-compaction.
      let lastContextTokens: number | null = null;
      let lastWindowTokens: number | null = null;
      let firstContextTokens: number | null = null;
      const textChunks: string[] = [];
      let finalText: string | null = null;
      /**
       * How the turn ended, set as its terminal event ARRIVES rather than once
       * the event's bookkeeping drains — so a call learns it the moment the
       * turn is over (`endedAs`), and `finish` reads the same value.
       */
      let outcome: NodeOutcome | null = null;
      const endedAs = (): NodeOutcome =>
        outcome ?? (cancelRequested ? 'cancelled' : 'completed');
      /**
       * Tool calls seen since the last `turn_complete`, counted here because no
       * CLI reports a total and the transcript a client loads is windowed.
       *
       * Today this closure is built per TURN, so it starts at zero anyway and
       * the zeroing below is unobservable — verified by mutation: removing it
       * changes no test. It stays because the durable write ADDS, so the day a
       * closure serves two turns (a kept session driving them, as the ACP
       * transport already does for its own state) an un-zeroed counter would
       * contribute the first turn's tools again on the second settle, and the
       * figure would silently overcount rather than fail.
       */
      let toolCalls = 0;
      // Never zeroed, unlike the counter above: whether the turn ACTED at all,
      // which decides if a failed pool member's call may be handed to the next.
      let madeToolCalls = false;
      // The turn's own CLI session — the broker's thread-resume handle.
      let capturedSessionId: string | null = null;
      /**
       * The last failure this turn's CLI reported, verbatim — the fact a CALLER
       * used to be denied (see `utils/callee-failure.ts`).
       *
       * The LAST rather than the first: a turn can report a recoverable error
       * and carry on, so what matters is whatever it said closest to ending.
       * Captured here, in the same closure `outcome` lives in, because the
       * `error` event is the only place the sentence exists — by `finish()` it
       * has already been written to the transcript and gone.
       */
      let lastError: string | null = null;
      /**
       * The cards THIS turn raised that nobody has answered yet (card id → the
       * blocker it holds on the broker) — what `retireCards` closes when the
       * turn ends. See there for why the node-wide sweep is not enough.
       */
      const openCards = new Map<string, string>();
      /**
       * Take one of this turn's cards down: its blockers released, its
       * registry entry abandoned — the card handed back for its row, or null
       * when the registry no longer held it.
       */
      const releaseCard = (
        cardId: string,
        blockerId: string,
      ): ReturnType<ApprovalRegistry['abandon']> => {
        openCards.delete(cardId);
        if (callContext) {
          this.callBroker.noteCalleeUnblocked(runId, callContext.callId);
        }
        this.callBroker.noteCallerUnblocked(runId, caller, blockerId);
        return this.approvals.abandon(runId, cardId);
      };

      // A call turn on a pool member other than the node's own settings. The
      // node's row — its resume handle, its window, its stamp — is member 1's:
      // a later DAG turn or a message to the node runs member 1, where another
      // member's session does not exist and whose model has another window.
      const otherPoolMember =
        callContext?.poolMember !== undefined && callContext.poolMember !== 1;
      // Stamped on every row that can carry this turn's spend, in the turn and
      // after it: which CLI and model that spend is filed under (`turnMemberOf`).
      const usageOwner = (kind: string): Record<string, string> =>
        otherPoolMember && carriesUsage(kind)
          ? {
              agentKind: node.agent,
              ...(node.model !== undefined ? { agentModel: node.model } : {}),
            }
          : {};
      const saveSessionId = createSessionIdSaver(
        this.nodeStateDao,
        runId,
        node.id,
        null,
        em,
        otherPoolMember,
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
      const nodeWindow = otherPoolMember
        ? null
        : (nodeWindows.get(node.id) ?? null);
      const input: AgentTurnInput = {
        prompt: withCarriedContext(carried, prompt),
        ...(extras.images?.length ? { images: extras.images } : {}),
        cwd,
        model: node.model ?? null,
        // Per NODE like the model, and already checked against this CLI's own
        // `listEfforts` at run start — a level it does not accept was dropped
        // there with a system item, so nothing unsupported reaches argv.
        effort: node.effort ?? null,
        // Per NODE too, and deliberately NOT pre-checked at run start the way
        // the effort is: the sizes belong to the model rather than to the CLI,
        // so there is no list here to check against — the turn's own driver
        // reports a size the model does not offer, against the live agent.
        contextWindow: node.contextWindow ?? null,
        modelParameters: node.modelParameters ?? null,
        // The node's threshold handed to the CLI ITSELF, so a turn that fills
        // the window compacts inside itself rather than running to the end and
        // being judged by `compactIfDue` when it is already too late. The same
        // percent both rules read, so the two can only ever agree; absent until
        // this node's window has been measured, and absent for good on a CLI
        // with no such control — `compactIfDue` remains the threshold there.
        ...(nodeWindow !== null && node.autoCompactPercent
          ? {
              autoCompact: {
                percent: node.autoCompactPercent,
                windowTokens: nodeWindow,
              },
            }
          : {}),
        // Never the session a carried compaction replaced: resuming it would
        // hand the summary to the conversation it summarised.
        resumeSessionId:
          carried !== null
            ? null
            : (callContext?.resumeSessionId ?? extras.resumeSessionId ?? null),
        systemPrompt: node.role ?? null,
        // A PEER of the role rather than something joined into it: the two are
        // composed by `AgentAdapter.composeSystemPrompt`, which ranks the
        // node's role after this so a node authored for one job still outranks
        // a standing preference. Joining them here would put that ordering in
        // the executor and leave the chat path free to disagree about it.
        customInstructions,
        // A peer on the same terms; ranked right after the user's own text.
        taskInstructions,
        // Joined here because the order of several blocks is a graph fact no
        // adapter could recover; ranked by `composeTurnInstructions`.
        instructionBlocks: instructionsFor(node.id),
        // This node's own CLI's slice; an option it does not carry reads as
        // that option's declared default, never as off.
        agentOptions: agentOptions[node.agent],
        callSurfacePrompt: callSurfaceFor(node),
        // A questionCapable AUTO node spawns in ask mode when its CLI's
        // question channel COSTS that posture (the daemon auto-approves plain
        // permissions below, so unattended semantics survive).
        // ask/acceptEdits already carry the dialogue and spawn as themselves.
        // A CLI whose questions arrive out-of-band declares the cost as false
        // and keeps `auto` — forcing ask there would park every permission in
        // an unwatched graph on a human verdict that never comes.
        approvalMode:
          questionCapable &&
          approval === 'auto' &&
          adapter.getConfig().questionsCostAskPosture
            ? 'ask'
            : approval,
        mcpEndpoint: mcpEndpointFor(node, callContext?.conversationId ?? null),
        // Per NODE, not per run: two nodes pointed at different plugin
        // directories are meant to run with different tools. Already refused
        // at startRun if unusable.
        configDir: node.configDir ?? null,
        // The servers this node — or, on a call, the pool MEMBER it runs as,
        // since `node` is that member's resolved view — switched off. Every
        // turn of the node carries them: a DAG turn, a callee sub-turn, a
        // continuation and the node's own compaction turn all come through
        // here. Each CLI applies them in its own adapter.
        ...(node.mcpDisabled?.length ? { mcpDisabled: node.mcpDisabled } : {}),
      };
      // This turn's compaction, until the row recording it is written — the
      // chat path's `compactions`, for a node's or a callee's own window.
      const compactions = new CompactionRows();
      const onEvent = (event: AgentEvent): void => {
        const arrived = terminalStatus(event);
        if (
          arrived === 'completed' ||
          arrived === 'failed' ||
          arrived === 'cancelled'
        ) {
          outcome = arrived;
        }
        enqueue(async () => {
          // Whether THIS event's approval request is the agent asking something
          // — set by the routing branch below and read by the registry track
          // further down. Per-event, declared here because the two blocks that
          // need it are siblings; false for every non-request event, which
          // never reaches either.
          let isQuestion = false;
          // The id this request's CARD goes by — its transcript row, its
          // registry entry and the verdict that comes back — minted once here
          // and scoped to this turn's process. `event.id` is unique only
          // within that process (cursor numbers `n:0`, `n:1`, … per
          // connection), so two cursor nodes, or two calls to one cursor
          // callee, both parked `n:1` and a verdict for one answered the other
          // (`ApprovalRegistry.mintCardId`). The CLI is still answered under
          // `event.id`, which the closures below keep.
          const cardId =
            event.type === 'approval_request'
              ? this.approvals.mintCardId(event.id, sessionKey)
              : null;
          if (event.type === 'user_message_consumed') {
            // The CLI took a message it was handed mid-turn; a wait started
            // from here on has nothing to make way for.
            this.callBroker.forgetUserMessage(runId, caller);
          }
          if (event.type === 'approval_withdrawn') {
            // The CLI took its request back, so its card has nobody left to
            // deliver a verdict to: close it, and release the blocker it held,
            // or the node reads as waiting on the user until its turn ends.
            const blockerId = `${sessionKey}#${event.id}`;
            for (const [openId, blocker] of [...openCards]) {
              if (blocker === blockerId) {
                const card = releaseCard(openId, blocker);
                // Announces the run is no longer waiting when it closed one.
                await recordUnanswerable(
                  node.id,
                  card === null ? [] : [card],
                )();
              }
            }
            return;
          }
          if (event.type === 'session') {
            capturedSessionId = event.sessionId;
            if (!callContext) {
              nodeSessionIds.set(node.id, event.sessionId);
            }
            await saveSessionId(event.sessionId);
            return;
          }
          if (event.type === 'slash_commands') {
            // The CLI's own invokable set for this run's cwd — feeds the
            // composer's `/` autocomplete, never the transcript.
            // Keyed by the NODE's config directory for the reason the MCP
            // harvest below takes it: a CLI answers for the plugins installed
            // in the profile it is running under.
            this.skillHarvest.record(
              node.agent,
              cwd,
              node.configDir ?? null,
              event.commands,
            );
            return;
          }
          if (event.type === 'mcp_servers') {
            // What this node actually loaded — feeds the MCP panel so it need
            // not re-dial every server to answer, never the transcript. Keyed
            // by the NODE's config directory, because a plugin ships its own
            // servers: two nodes on one CLI pointed at different ones load
            // genuinely different sets, and filing both under the folder alone
            // would serve each the other's answer.
            this.mcpHarvest.record(
              node.agent,
              cwd,
              node.configDir ?? null,
              event.servers,
            );
            return;
          }
          if (event.type === 'usage_progress') {
            // The node's own running bill for this turn — the graph twin of
            // `ChatService`'s site, and ephemeral for the same reason: the
            // turn's `turn_complete` usage is the durable copy.
            this.partials.spend(runId, ownerKey, node.id, event);
            return;
          }
          if (event.type === 'cost_progress') {
            // The dollars this turn has spent that no durable row carries yet,
            // under the same owner key — so a CALL's card adds its own running
            // turn to what its finished turns recorded, rather than showing the
            // finished turns alone as if they were the bill.
            this.partials.cost(runId, ownerKey, node.id, event.costUsd);
            return;
          }
          if (event.type === 'context_progress') {
            lastContextTokens = event.contextTokens;
            if (firstContextTokens === null && event.contextTokens > 0) {
              firstContextTokens = event.contextTokens;
            }
            if (
              event.contextWindowTokens !== undefined &&
              event.contextWindowTokens !== null
            ) {
              lastWindowTokens = event.contextWindowTokens;
            }
            // BEFORE the figure it scales — `context` publishes, so a window
            // remembered after it would not reach the client until the next
            // reading. See the same pair in `ChatService`.
            if (
              event.contextWindowTokens !== undefined &&
              event.contextWindowTokens !== null
            ) {
              this.partials.rememberWindow(
                runId,
                ownerKey,
                event.contextWindowTokens,
                event.contextModel ?? null,
                node.contextWindow ?? null,
              );
            }
            // EPHEMERAL, like a text delta: the durable copy is the
            // turn_complete usage. This is what lets a NODE's meter move while
            // its turn runs — the owner key is the node, so a fan-out's agents
            // each report their own conversation rather than one shared figure.
            this.partials.context(
              runId,
              ownerKey,
              node.id,
              event.contextTokens,
            );
            // …and the DURABLE copy, which is what a client with no live plane
            // reads. The live plane is dropped on a reload, a reconnect and a
            // first open, and a node parked in `await_agent` emits nothing for
            // minutes — so without this the ring simply went blank on exactly
            // the node the reader was asking about. Fire-and-forget for the
            // reason every other write on this path is: a failed bookkeeping
            // write must not fail the turn.
            //
            // A reading naming no window borrows the one the live plane holds
            // for this owner, resolved HERE rather than inside the queued
            // callback: the queue drains later, and a model change in between
            // deletes that entry — so a deferred read would file null for a
            // reading that had a window at the moment it was taken.
            const windowTokens =
              event.contextWindowTokens ??
              this.partials.windowFor(runId, ownerKey);
            // The node row is member 1's: another member's reading is of
            // another model's window, and lives on its call row alone.
            if (!otherPoolMember) {
              rememberNodeWindow(node.id, windowTokens);
              enqueue(() =>
                this.nodeStateDao
                  .rememberContext(
                    runId,
                    node.id,
                    event.contextTokens,
                    windowTokens,
                    em,
                  )
                  .catch(() => {}),
              );
            }
            // And again per CALL, where there is one: a DAG-launched node
            // carries no `callContext` and no call identity to key a row on, so
            // it writes the node row above and nothing here.
            if (callContext) {
              enqueue(() =>
                this.callContextDao
                  .rememberContext(
                    runId,
                    callContext.callId,
                    node.id,
                    event.contextTokens,
                    windowTokens,
                    em,
                  )
                  .catch(() => {}),
              );
            }
            return;
          }
          if (event.type === 'turn_model') {
            // Named at session start, before any usage exists — this is what
            // lets a node's FIRST request be scaled against the real window,
            // and what teaches the cross-run cache a model it has never seen.
            this.partials.useModel(
              runId,
              ownerKey,
              adapter.getConfig().kind,
              event.model,
              node.contextWindow ?? null,
            );
            return;
          }
          if (
            event.type === 'tool_call' &&
            event.parentToolUseId === undefined
          ) {
            // This node's OWN tools, never its delegates'. `parentToolUseId` is
            // the daemon-side twin of the renderer's `subagentIdOf` exclusion:
            // a delegate has its own card and its own rows, so folding its
            // toolbelt in here would report a fan-out's total as one node's.
            toolCalls += 1;
            madeToolCalls = true;
          }
          if (event.type === 'text') {
            textChunks.push(event.text);
          }
          if (event.type === 'turn_complete') {
            finalText = event.finalText ?? textChunks.join('');
            lastContextTokens = event.usage?.contextTokens ?? lastContextTokens;
            if (firstContextTokens === null && (lastContextTokens ?? 0) > 0) {
              firstContextTokens = lastContextTokens;
            }
            lastWindowTokens =
              event.usage?.contextWindowTokens ?? lastWindowTokens;
            // The ONLY line carrying the model's window — under the model that
            // REPORTED it, so a node that fell back to a second model cannot
            // file that model's window under the requested one.
            this.partials.rememberWindow(
              runId,
              ownerKey,
              event.usage?.contextWindowTokens ?? null,
              event.usage?.contextModel ?? null,
              node.contextWindow ?? null,
            );
            // The result line is the ONLY one carrying the window, so it is
            // where a node's denominator becomes durable — the count beside it
            // is written too, since a turn that reported none mid-flight still
            // states its total here. A result line that names no window falls
            // back to the live plane, resolved eagerly for the reason the
            // reading above states.
            const settledWindowTokens =
              event.usage?.contextWindowTokens ??
              this.partials.windowFor(runId, ownerKey);
            if (!otherPoolMember) {
              rememberNodeWindow(node.id, settledWindowTokens);
              enqueue(() =>
                this.nodeStateDao
                  .rememberContext(
                    runId,
                    node.id,
                    event.usage?.contextTokens ?? null,
                    settledWindowTokens,
                    em,
                  )
                  .catch(() => {}),
              );
            }
            if (callContext) {
              enqueue(() =>
                this.callContextDao
                  .rememberContext(
                    runId,
                    callContext.callId,
                    node.id,
                    event.usage?.contextTokens ?? null,
                    settledWindowTokens,
                    em,
                  )
                  .catch(() => {}),
              );
            }
            // This turn's worked time and tool count, ADDED to the node's
            // running totals. `rememberWork` rather than another
            // `rememberContext` because these are totals rather than levels —
            // the reading above may be overwritten harmlessly, this one may not.
            // Read out and zeroed HERE, synchronously, for the reason the window
            // above is resolved eagerly: the queue drains later, and by then the
            // next turn's calls would already have moved the counter.
            const turnToolCalls = toolCalls;
            toolCalls = 0;
            const turnWorkedMs = event.usage?.durationMs ?? null;
            enqueue(() =>
              this.nodeStateDao
                .rememberWork(runId, node.id, turnWorkedMs, turnToolCalls, em)
                .catch(() => {}),
            );
          }
          if (event.type === 'error') {
            lastError = event.message;
          }
          const terminal = terminalStatus(event);
          if (
            (terminal === 'failed' || terminal === 'cancelled') &&
            capturedSessionId === null
          ) {
            restoreCarried();
          }
          if (event.type === 'approval_request') {
            // The caller-bridge admits ONLY AskUserQuestion by NAME: bridging
            // on the CLI-owned requires_user_interaction flag alone could let
            // a future interactive tool bypass an 'ask' node's human gate via
            // version drift. A flag-only request stays on the approval path
            // (card or daemon auto-approve per node.approval) with a warning
            // so the drift is loud, never silent.
            // Read ONCE per request and kept for the track below, which sits in
            // a second `approval_request` block further down: recomputing it
            // there would be a second reading of one adapter fact, free to
            // disagree with the branch that already routed this request.
            isQuestion = isUserQuestion(
              adapter.getConfig().questionToolName,
              event.toolName,
            );
            if (!isQuestion && event.requiresUserInteraction === true) {
              this.logger.warn(
                `interactive control_request for unrecognized tool '${event.toolName}' on ${node.id} — kept on the approval path, not bridged to the caller`,
              );
            }
            if (callContext && isQuestion && !asksForSecret(event.questions)) {
              // A call-initiated callee's question goes to its CALLER (the
              // M4 Q&A bridge) — never to a renderer card. The broker parks
              // it; answer_agent delivers the answer through these closures.
              //
              // Except a question asking for a SECRET, which falls through to
              // the user's own card: only the user can answer it, and a caller
              // escalating it would ask on a card of its own CLI, which cannot
              // mask the field or keep the answer out of the transcript.
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
                    deliverApprovalAnswer(
                      adapter,
                      event,
                      true,
                      answer,
                      (input) => handle.respondApproval(event.id, true, input),
                    ).delivered,
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
          // Anything durable ends a silent reasoning stretch — the tool call
          // the model went quiet to prepare carries no text delta to close it
          // (see `PartialStreamService.endThinking`). Kept in step with the
          // chat path, which does the same at its own persist seam.
          this.partials.endThinking(runId, ownerKey, node.id);
          this.backgroundWork.record(runId, event);
          const mapped = mapEventToItem(event);
          // A compaction the agent finished: stamped onto its summary, or
          // written on its own ahead of this row — nothing else records one.
          for (const row of compactions.rowsBefore(event, mapped)) {
            await persistItem(node.id, row.kind, row.role, {
              ...row.payload,
              nodeId: node.id,
              ...(callContext ? { callId: callContext.callId } : {}),
            });
          }
          if (mapped) {
            // A callee sub-turn tags every streamed item with its callId so
            // the renderer can nest the whole sub-turn under its call block —
            // unambiguous even when parallel calls hit the SAME node.
            try {
              await persistItem(node.id, mapped.kind, mapped.role, {
                ...(mapped.payload as Record<string, unknown>),
                // A card row carries the CARD id, which is what the renderer
                // sends back as the verdict's `requestId`.
                ...(cardId !== null ? { id: cardId } : {}),
                nodeId: node.id,
                ...(callContext ? { callId: callContext.callId } : {}),
                ...usageOwner(mapped.kind),
              });
              if (callContext) {
                // A tool call in flight holds the watchdog off until it
                // answers: the callee is waiting on its own work, however long
                // that takes (a delegate can run for many minutes and say
                // nothing on the wire).
                if (event.type === 'tool_call') {
                  this.callBroker.noteCalleeToolStarted(
                    runId,
                    callContext.callId,
                    event.id,
                  );
                } else if (event.type === 'tool_result') {
                  this.callBroker.noteCalleeToolFinished(
                    runId,
                    callContext.callId,
                    event.id,
                  );
                } else if (
                  event.type === 'subagent_info' &&
                  event.parentToolUseId == null
                ) {
                  // A BACKGROUND delegate is the same wait, outliving the tool
                  // call that launched it — a cursor turn is held open for its
                  // delegates with nothing on the wire until they end. Keyed
                  // apart from tool ids, since a delegate's id IS its launching
                  // call's, which already answered.
                  const unit = `delegate:${event.id}`;
                  if (event.backgroundOpen === true) {
                    this.callBroker.noteCalleeToolStarted(
                      runId,
                      callContext.callId,
                      unit,
                    );
                  } else if (
                    event.backgroundOpen === false ||
                    event.backgroundOutcome != null
                  ) {
                    this.callBroker.noteCalleeToolFinished(
                      runId,
                      callContext.callId,
                      unit,
                    );
                  }
                }
                // This callee is demonstrably alive — restart its silence
                // watchdog. The broker holds a promise and nothing else, so
                // this seam is the only place a callee's output is visible.
                this.callBroker.noteCalleeActivity(runId, callContext.callId);
              }
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
          if (event.type === 'approval_request' && cardId !== null) {
            // A CALLEE parked on a card is waiting on a person, not wedged —
            // stand its silence window down until the verdict lands, the same
            // carve-out `spawn-cli.ts` makes for its own deadline. A CALLER
            // parked on one cannot answer its callees until the verdict lands
            // either, so the questions they park wait with it rather than
            // expiring against a caller that cannot see them.
            //
            // Any node, a callee included: one that is itself a caller
            // (Manager → Engineer → Researcher) is blocked by its cards on the
            // same terms. The BLOCKER is named by its session and request id —
            // not by the card id, which is fresh per card — so a request
            // re-offered to a later turn of the same process is one blocker
            // rather than two.
            const blockerId = `${sessionKey}#${event.id}`;
            if (callContext) {
              this.callBroker.noteCalleeBlocked(runId, callContext.callId);
            }
            this.callBroker.noteCallerBlocked(runId, caller, blockerId);
            openCards.set(cardId, blockerId);
            this.approvals.track({
              runId,
              nodeId: node.id,
              requestId: cardId,
              toolName: event.toolName,
              input: event.input,
              // Already decided above from this node's adapter — the registry
              // never re-derives it (`PendingApproval.question`).
              question: isQuestion,
              respond: (allow, answer) => {
                openCards.delete(cardId);
                // The card is gone whatever the delivery outcome, so the
                // window restarts either way — a refused delivery leaves the
                // callee unblocked from this side's point of view.
                if (callContext) {
                  this.callBroker.noteCalleeUnblocked(
                    runId,
                    callContext.callId,
                  );
                }
                this.callBroker.noteCallerUnblocked(runId, caller, blockerId);
                const { delivered, record } = deliverApprovalAnswer(
                  adapter,
                  event,
                  allow,
                  answer,
                  (input) => handle.respondApproval(event.id, allow, input),
                );
                if (delivered) {
                  enqueue(async () => {
                    await persistItem(node.id, 'approval_verdict', null, {
                      id: cardId,
                      nodeId: node.id,
                      allow,
                      ...record,
                    });
                  });
                }
                // The registry dropped this entry before calling here, so the
                // reading is already the post-verdict one — whatever the
                // delivery outcome, the card is gone.
                this.announceAwaiting(runId);
                return delivered;
              },
            });
            this.announceAwaiting(runId);
          }
        });
      };
      /**
       * What the CLI does AFTER this turn's terminal line, filed under the node
       * that was working — the graph's half of `ChatService`'s own between-turn
       * handler, and the reason the process is now kept.
       *
       * A turn's `result` ends what the AGENT was saying; it does not stop the
       * process, which routinely opens a further turn of its own when work it
       * backgrounded reports back. Every row of that used to be dropped here —
       * `adapter.start` supplied no sink — so a callee that launched a build and
       * said so left nothing in the transcript afterwards but the sentence that
       * it had started.
       *
       * Rows ONLY. It deliberately touches none of the turn bookkeeping above:
       * `outcome`, `finalText` and `textChunks` describe a turn whose envelope
       * the caller has already been handed, and rewriting any of them would
       * change an answer that has been acted on. So this makes the work VISIBLE
       * without re-opening a settled call.
       *
       * It goes on writing after this PASS has ended: the process is kept
       * between passes, so a dev server exiting, or the CLI reacting to it,
       * is real work that happened in this run and must reach its transcript —
       * dropping it left a finished command listed as running for good. Only a
       * run being DELETED is refused, since its rows are going.
       */
      const offTurnCompactions = new CompactionRows();
      const onOffTurnEvent = (event: AgentEvent): void => {
        enqueue(async () => {
          if (this.deleting.has(runId)) {
            return;
          }
          this.backgroundWork.record(runId, event);
          const mapped = mapEventToItem(event);
          const settles = terminalStatus(event) !== null;
          const callId = callContext ? callContext.callId : null;
          // AHEAD of the rows this event produces, so the live row stands above
          // the work rather than appearing under the last of it.
          //
          // `restatesRunAsWorking` is the same predicate the chat side applies,
          // and it earns its place here for the same reason: a backgrounded
          // command's own open and close are bookkeeping ABOUT work rather than
          // an agent producing any, and a close emits nothing after it — so
          // reading one as the node working would latch a spinner that nothing
          // could take down. A TERMINAL event is excluded on top of it, or a
          // stretch that begins with one (a held result released off-turn)
          // would write a `running` and restore it in the same breath.
          //
          // A BRACKETED delegate's own rows are excluded too, as the chat side
          // excludes them from its lease: the delegate is on the card already
          // (its block, `subagentsOut`), its close is what ends it, and a close
          // is no terminal event — so its steps, read as the NODE working,
          // latched the node `running` for good after its sub-agents finished.
          // Measured on a codex callee whose sub-agents stream their steps.
          const bracketedDelegateRow =
            event.parentToolUseId !== undefined &&
            this.backgroundWork.isDelegateOut(runId, event.parentToolUseId);
          if (
            mapped !== null &&
            !settles &&
            !bracketedDelegateRow &&
            restatesRunAsWorking(event)
          ) {
            await takeOffTurnNodeBadge(sessionKey, node.id, callId);
          }
          for (const row of offTurnCompactions.rowsBefore(event, mapped)) {
            await persistItem(node.id, row.kind, row.role, {
              ...row.payload,
              nodeId: node.id,
              ...(callId ? { callId } : {}),
            });
          }
          if (!mapped) {
            return;
          }
          await persistItem(node.id, mapped.kind, mapped.role, {
            ...(mapped.payload as Record<string, unknown>),
            nodeId: node.id,
            ...(callId ? { callId } : {}),
            ...usageOwner(mapped.kind),
          });
          // AFTER the terminal row, which is the continuation ENDING: the badge
          // goes back to whatever this stretch took it from.
          if (settles) {
            await restoreOffTurnNodeBadge(sessionKey);
          }
        });
      };
      /**
       * The same verdict the in-turn path gives, for a request that arrives with
       * no turn left to carry it — see the `questionCapable && auto` branch in
       * `onEvent`.
       *
       * Without it the between-turn default (refuse a permission) would reach
       * the agent as the USER's own "no" on an unattended graph node, for a card
       * nobody was ever shown — and the continuation that a backgrounded unit's
       * report opens is made almost entirely of tool calls, so keeping the
       * process alive while refusing everything it then tries to do would be a
       * worse failure than killing it.
       *
       * Everything else HOLDS (`null`) rather than being decided: a question
       * raised here can no longer be bridged to a caller whose call has settled,
       * and no card can be drawn for it, so answering either way would be
       * inventing a verdict. The request stays parked until the run closes the
       * session, which is the honest end for it.
       *
       * The same verdict after this PASS has ended as during it: the process is
       * kept between passes and `onOffTurnEvent` goes on recording what it does,
       * so the grant is no longer one with no transcript — which was the only
       * reason it used to hold everything once the pass had finished.
       */
      const onBetweenTurnApproval = (request: {
        toolName: string;
      }): boolean | null =>
        questionCapable &&
        approval === 'auto' &&
        !isUserQuestion(adapter.getConfig().questionToolName, request.toolName)
          ? true
          : null;
      // One registry key per CONVERSATION, never per node: a callable DAG node
      // can hold its own turn and several callee turns at once, and a key
      // serving two concurrent turns would have the second refused — which the
      // registry reads as "replace it", killing the first turn's process
      // mid-work. A DAG node runs one conversation, so `node:<id>` is its key;
      // a callee's is the FIRST call of its conversation, which a `thread:`
      // continuation shares with every call before it. It was the call's own
      // id for a while, and that spawned a second `--resume <session>` process
      // for every continuation while the previous call's process was still
      // kept under the previous id — two live CLIs on one session, both
      // answering one message and editing one worktree (measured: an Engineer
      // found two, then three, `claude -p --resume 43bb7bb7…` children of the
      // daemon in its worktree). Keyed by the conversation, the continuation
      // is handed to the kept process, and the session is resumed in a fresh
      // one only once that process is gone. The broker refuses a continuation
      // while a call on that conversation is live, which is what keeps the
      // "one turn per key" premise of the registry true. The `call:`/`node:`
      // prefixes keep a callable node's two kinds of turn from colliding on
      // its own id.
      // The live plane's key for THIS turn. Per CALL rather than per node,
      // because a node can hold several at once — a caller running two of the
      // same callee had both write to one key, so the panel showed one ring
      // flickering between two unrelated conversations while honestly counting
      // "2 active · 2 threads" above it. The published nodeId stays the NODE's,
      // so a client can still attribute the reading.
      const ownerKey = partialOwnerKey(node.id, callContext?.callId ?? null);
      let handle: AgentTurnHandle;
      try {
        handle = this.sessions.startTurn(
          sessionKey,
          adapter,
          input,
          onEvent,
          onBetweenTurnApproval,
          onOffTurnEvent,
        );
      } catch (err) {
        restoreCarried();
        throw err;
      }
      // The registry may close this process at any time — reaped as unused,
      // evicted, replaced as stale, or ended by the run's archive — during this
      // pass or long after it, since the process is kept between passes. Every
      // delegate inside it dies with it. Its detached commands need nothing
      // from here: the process exit announces their closes through
      // `onOffTurnEvent` itself.
      //
      // Installed AFTER `startTurn`, never before it: a kept process that
      // cannot serve this turn is REPLACED inside that call and its close
      // fires synchronously, so a closer installed first was consumed by the
      // replacement of the process before it — closing nothing that process
      // had left out, and leaving the new process with no closer at all.
      //
      // For a callee it covers every CALL the process has served, not this one
      // alone ({@link callsBySessionKey}).
      if (callContext) {
        const calls = callsBySessionKey.get(sessionKey) ?? new Set<string>();
        calls.add(callContext.callId);
        callsBySessionKey.set(sessionKey, calls);
      }
      this.sessionClosers.set(sessionKey, () => {
        // Read as the process CLOSES: the calls it served are the ones whose
        // work died with it, and a process spawned on this key later starts
        // its own list.
        const scopes: Parameters<typeof closeStrandedWork>[0][] = callContext
          ? [...(callsBySessionKey.get(sessionKey) ?? [])].map((callId) => ({
              callId,
            }))
          : [{ nodeId: node.id }];
        callsBySessionKey.delete(sessionKey);
        enqueue(async () => {
          // A deleted run's rows are going; every other close is written.
          if (this.deleting.has(runId)) {
            return;
          }
          for (const scope of scopes) {
            await closeStrandedWork(scope, false);
          }
          // The process that owed this stretch's terminal event is gone, so
          // nothing else could ever end it — the second of the two endings
          // {@link restoreOffTurnNodeBadge} exists for. A no-op unless this
          // conversation actually took a badge.
          await restoreOffTurnNodeBadge(sessionKey);
        });
      });

      const finish = (): NodeTurnResult => {
        // What this turn spent that no row carries is either recorded by now
        // or will be by a line this key no longer answers for — so the live
        // figure comes down with the turn, never to be added twice.
        this.partials.retireCost(runId, ownerKey, node.id);
        // A clean exit with no result line still completes the node — the
        // synthetic-completion mirror of the chat turn's finalizer.
        const finalOutcome = endedAs();
        const text =
          finalOutcome === 'completed'
            ? (finalText ?? textChunks.join(''))
            : finalText;
        return {
          outcome: finalOutcome,
          finalText: text,
          sessionId: capturedSessionId,
          reading: {
            tokens: lastContextTokens,
            window:
              lastWindowTokens ?? this.partials.windowFor(runId, ownerKey),
          },
          firstTokens: firstContextTokens,
          sessionKey,
          error: lastError,
          madeToolCalls,
        };
      };
      /**
       * Close the cards THIS turn left unanswered, and release the blockers
       * they held — for a settle path to call when the turn ends while its node
       * still has OTHER live turns, where the node-wide sweep does not run.
       *
       * Each such card is dead the moment its turn settles: its buttons answer
       * the settled turn's handle, which refuses the write, and a request the
       * CLI still holds is offered to the next turn as a card of its own. Left
       * in place, the card stayed on screen answering into nothing, and its
       * blocker kept every question this node's own callees parked
       * TTL-suspended until the node's LAST turn ended — so a callee that was
       * itself a caller could never time its callees' questions out while any
       * other call to it was running.
       *
       * The same two halves as `sweepApprovals`: the registry and the broker
       * are released now, synchronously, and the rows are written by the
       * returned work on the chain.
       */
      const retireCards = (): (() => Promise<void>) => {
        const retired: ReturnType<ApprovalRegistry['sweepNode']> = [];
        for (const [cardId, blockerId] of [...openCards]) {
          const card = releaseCard(cardId, blockerId);
          if (card !== null) {
            retired.push(card);
          }
        }
        return recordUnanswerable(node.id, retired);
      };
      return { handle, finish, endedAs, retireCards };
    };

    /**
     * Compact one conversation right after the turn that filled it, while the
     * unit that owns its session key still holds it — so nothing else can open
     * a turn on that key meanwhile: a callee's call is still active
     * (`THREAD_BUSY`), and a node's own turn is still retained and unsettled.
     * The node's settle, and a sync caller's result, simply wait for it.
     *
     * NEVER called from inside `enqueue`: the compaction's own events are
     * enqueued, and awaiting them from a queued callback would wait forever.
     *
     * `onStart` fires only when a compaction actually begins, which is what
     * lets a node's settle path mark it busy for exactly that long.
     */
    /**
     * How many delegates ONE call launched that its transcript still declares
     * out — read on the write chain, so every row the turn produced has landed.
     * A read that fails
     * answers 0: it only decides whether the caller is WARNED, and must never
     * cost the call its result.
     */
    const delegatesOutOfCall = (callId: string): Promise<number> =>
      new Promise((resolve) => {
        enqueue(async () => {
          try {
            resolve(
              strandedDelegates(
                await this.itemDao.subagentInfoRows(runId, em),
              ).filter((delegate) => delegate.callId === callId).length,
            );
          } catch {
            resolve(0);
          }
        });
      });

    const compactIfDue = async (
      node: WorkflowAgentNode,
      turn: NodeTurnResult,
      callContext:
        | { callId: string; conversationId: string; poolMember?: number }
        | undefined,
      onStart: () => void,
    ): Promise<void> => {
      try {
        const percent = node.autoCompactPercent ?? null;
        const command = this.adapterFor(node.agent).geniroCommandFor(
          AUTO_COMPACT_COMMAND,
        );
        if (
          percent === null ||
          command === null ||
          turn.outcome !== 'completed' ||
          cancelRequested ||
          // A pass that is over refuses — unless the run is AWAKE for work its
          // own agents started (`reopenRun`), which is where a call-driven
          // workflow spends nearly all of its life: the Manager dispatches,
          // ends its turn, and every call after that wakes the run. Refusing
          // there meant the rule never ran for a CLI with no in-turn control of
          // its own, nor for a claude node's first turn before its window is
          // known.
          (runFinished && !reopened)
        ) {
          return;
        }
        let baseline = this.compactionBaselines.get(turn.sessionKey);
        if (baseline === 'pending') {
          // What the compaction left behind is the conversation's size at the
          // START of the next turn, never at its end: a long turn that regrew
          // past the threshold was measured as its own baseline, so it had to
          // grow a further tenth of the window before it compacted again.
          const opening = turn.firstTokens ?? turn.reading.tokens;
          if (opening === null) {
            return;
          }
          baseline = opening;
          this.compactionBaselines.set(turn.sessionKey, opening);
        }
        if (!autoCompactDue(percent, turn.reading, baseline ?? null)) {
          return;
        }
        onStart();
        const owner = {
          nodeId: node.id,
          ...(callContext ? { callId: callContext.callId } : {}),
        };
        /**
         * The line explaining the compaction, written ONLY once one has
         * actually happened — the chat path's own rule
         * (`ChatService.autoCompactIfDue` writes it after `/compact` has taken
         * the run), and this path did the opposite.
         *
         * REPORTED as auto-compact "not working", and reconstructed from the
         * reporter's run `8ad93b70`: the row said `Context reached the 80%
         * auto-compact threshold (84% — 840k of 1000k tokens) — compacting the
         * conversation` at seq 2121, five milliseconds after the previous
         * turn's end, and no compaction ever followed it. So the transcript
         * claimed a compaction that did not happen, which is the half of the
         * defect the user could see.
         */
        const sayCompacted = (): void => {
          enqueue(async () => {
            await persistItem(node.id, 'system', null, {
              message: autoCompactNotice(percent, turn.reading),
              severity: 'info',
              ...owner,
            }).catch(() => {});
          });
        };
        /** Said instead when the turn ran and the conversation did not shrink. */
        const sayNotCompacted = (why: string): void => {
          enqueue(async () => {
            await persistItem(node.id, 'system', null, {
              message: `Automatic compaction did not take — ${why}. The conversation was left as it was, and it will be tried again after the next turn.`,
              severity: 'warning',
              ...owner,
            }).catch(() => {});
          });
        };
        const compaction = await beginAgentTurn(
          node,
          command.prompt,
          callContext
            ? { ...callContext, resumeSessionId: turn.sessionId }
            : undefined,
          callContext ? {} : { resumeSessionId: turn.sessionId },
        );
        compactionHandles.add(compaction.handle);
        try {
          await compaction.handle.done;
          await drained();
        } finally {
          compactionHandles.delete(compaction.handle);
        }
        const result = compaction.finish();
        if (result.outcome !== 'completed') {
          // Stopped or failed: nothing shrank, so the rule stays armed.
          return;
        }
        if (command.replacesSession) {
          const summary = result.finalText?.trim() ?? '';
          if (summary === '') {
            enqueue(async () => {
              await persistItem(node.id, 'system', null, {
                message:
                  'Automatic compaction produced no summary — the conversation was left as it was.',
                severity: 'warning',
                ...owner,
              }).catch(() => {});
            });
            return;
          }
          this.carriedSummaries.set(turn.sessionKey, summary);
          this.sessions.retire(
            turn.sessionKey,
            'its conversation was compacted',
          );
          sayCompacted();
          enqueue(async () => {
            // The CONVERSATION's figure: a call's own row for a callee, the
            // node's for its own conversation — never the other one.
            await (
              callContext
                ? this.callContextDao.forgetContext(
                    runId,
                    callContext.callId,
                    em,
                  )
                : this.nodeStateDao.forgetContext(runId, node.id, em)
            ).catch(() => {});
            await persistItem(node.id, 'system', null, {
              message:
                'Conversation compacted. The agent starts fresh from the summary above; everything before it is no longer in its context.',
              severity: 'info',
              // TWIN PARSER: `apps/ui/src/renderer/chats/compaction-payload.ts`'s
              // `conversationReplaced` — the chat twin is `commitCarriedCompaction`.
              conversationReplaced: true,
              ...owner,
            }).catch(() => {});
          });
        } else {
          /**
           * A CLI that compacts IN PLACE has to be checked, because a turn
           * that "completed" is not a compaction — it is only a turn that
           * ended.
           *
           * MEASURED on run `8ad93b70`: the `/compact` reached the model as
           * ordinary text and it answered in prose, writing a message headed
           * `## State at compaction`, running three shell commands, and leaving
           * the window at 847,339 tokens against the 840k it started from. The
           * CLI's own compaction never ran and no compaction marker was ever
           * written. The likeliest reason is that the process was mid
           * CONTINUATION of its own — that engineer had background work
           * (`shell_info` three rows earlier), and a turn opened on a process
           * already working is delivered as a mid-turn follow-up, where a
           * leading slash command is not expanded.
           *
           * Nothing on the wire announces that, so this does not try to predict
           * it: it checks the one thing a compaction is FOR. The window must
           * have shrunk. An unshrunk window, or a turn that reported no reading
           * at all, is not a compaction — and both leave the rule ARMED, which
           * is what turns the failure into one wasted turn instead of a run.
           *
           * Because without this the failure DISARMED the feature: the baseline
           * below was set anyway, the next turn recorded ~847k as what the
           * compaction had left behind, and at a 1M window the next trigger
           * moved to ~94.7% — so nothing compacted again for the rest of that
           * run, under a transcript line saying one had.
           */
          const before = turn.reading.tokens;
          const after = result.reading.tokens;
          if (before === null || after === null) {
            sayNotCompacted('the agent reported no context reading for it');
            return;
          }
          if (after >= before) {
            sayNotCompacted(
              `the conversation did not shrink (${after} tokens against ${before} before it)`,
            );
            return;
          }
          sayCompacted();
        }
        this.compactionBaselines.set(turn.sessionKey, 'pending');
      } catch (err) {
        this.logger.warn(
          `workflow run ${runId} node ${node.id} auto-compaction failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    const launchNode = async (node: WorkflowAgentNode): Promise<void> => {
      startingDagNodes.add(node.id);
      markRootWorking(node.id, true);
      persistTurnStart(node, nodeSessionKey(runId, node.id));

      const prompt = this.composePrompt(
        seedPrompt,
        producersOf.get(node.id) ?? new Set(),
        nodesById,
        finalTexts,
      );
      retainNodeTurn(node.id);
      retainConversation(node.id);
      // A synchronous throw out of beginAgentTurn (e.g. prepareTurn's
      // config-file write fails) must settle THIS node as failed and keep the
      // DAG walking — drive()/startRun promise "never throws", and letting it
      // escape would leave the aggregate handle registered but never settling.
      let handle: AgentTurnHandle;
      let finish: () => NodeTurnResult;
      let retireCards: () => () => Promise<void>;
      try {
        ({ handle, finish, retireCards } = await beginAgentTurn(
          node,
          prompt,
          undefined,
          {
            // An earlier pass of this run left this node a conversation; a
            // follow-up's pass carries it on rather than starting it over.
            resumeSessionId: run.resumeSessions.get(node.id) ?? null,
            images: triggerFed.has(node.id) ? run.seedImages : [],
          },
        ));
      } catch (err) {
        startingDagNodes.delete(node.id);
        markRootWorking(node.id, false);
        // Gated like the three sibling settle paths (:1193, and the two cancel
        // routes): a callable DAG node can hold live CALLEE turns alongside its
        // DAG turn — which is why `liveTurnsByNode` exists at all — so sweeping
        // unconditionally here would mark a still-answerable card unanswerable
        // and drain a live caller's parked questions, because an unrelated
        // turn failed to spawn.
        const lastTurn = releaseNodeTurn(node.id);
        const recordSwept = lastTurn ? sweepApprovals(node.id) : null;
        endConversationTurn(node.id);
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
      startingDagNodes.delete(node.id);
      runningHandles.set(node.id, handle);

      void handle.done.then(async () => {
        // Compacted BEFORE the settle, while this turn still owns the node's
        // session key — see `compactIfDue`.
        await drained();
        const settledTurn = finish();
        await compactIfDue(node, settledTurn, undefined, () => {
          compactingNodes.add(node.id);
        });
        enqueue(async () => {
          // Other turns of this node may live on, and then the node-wide sweep
          // does not run — but THIS turn's cards are dead all the same.
          const recordSwept = releaseNodeTurn(node.id)
            ? sweepApprovals(node.id)
            : retireCards();
          // What this conversation's callees left it is drained to it now:
          // woken for, or orphaned when it was already told.
          endConversationTurn(node.id);
          await recordSwept();
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
            compactingNodes.delete(node.id);
            // Downstream nodes launch FIRST, so the walk moving on never reads
            // as an idle pass; and after `settled`, so a message arriving on a
            // real idle announce finds the root settled, not "still starting".
            schedule();
            markRootWorking(node.id, false);
          }
        });
      });
    };

    const cancelledOutcome: CalleeTurnOutcome = {
      status: 'cancelled',
      finalText: null,
      error: 'run cancelled',
      // A cancel is not a failure, so it carries no class: the broker answers a
      // cancelled call with CALLEE_CANCELLED and never reads these.
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    };

    /**
     * A call the CALLER stopped, before its turn ever ran. Told apart from the
     * run's own cancel in wording alone — the broker stamps the reason the
     * caller gave onto the envelope it finally hands back.
     */
    const callerCancelledOutcome: CalleeTurnOutcome = {
      status: 'cancelled',
      finalText: null,
      error: 'cancelled by the calling agent',
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    };

    /**
     * A call that reached this pass after a follow-up message had claimed the
     * run for its next one — see `supersededByNextPass`. Nothing ran, so it is
     * geniro's own side and the caller's right move is to make it again: by
     * then the next pass serves the call surface.
     */
    const supersededOutcome: CalleeTurnOutcome = {
      status: 'failed',
      finalText: null,
      ...geniroSideFailure(
        'a new message to this run was starting its next pass as this call arrived, so the call did not run — make it again',
      ),
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
      conversationId: string,
      pool?: CalleePoolPlan,
    ): Promise<CalleeTurnOutcome> => {
      /**
       * ONE attempt at the call, as one member of the callee's pool. `handsOn`
       * decides — once, inside the attempt's own settle — whether the call
       * moves on to the next member; such an attempt does not report the call
       * as settling, since the call has no result yet.
       */
      const runAttempt = async (
        callee: WorkflowAgentNode,
        member: number | undefined,
        /** Whether this is the call's first attempt. */
        first: boolean,
        prompt: string,
        resumeSessionId: string | null,
        /** Null for the last attempt, which nothing can hand on. */
        handsOn:
          | ((outcome: CalleeTurnOutcome, madeToolCalls: boolean) => boolean)
          | null,
      ): Promise<{ outcome: CalleeTurnOutcome; handedOn: boolean }> => {
        calleeTurnCounts.set(
          callee.id,
          (calleeTurnCounts.get(callee.id) ?? 0) + 1,
        );
        retainNodeTurn(callee.id);
        // The conversation this call speaks in — what its own calls are
        // owned by (`utils/caller-key.ts`).
        const calleeCaller = callerKey(callee.id, conversationId);
        retainConversation(calleeCaller);
        // A synchronous throw out of beginAgentTurn (e.g. prepareTurn's
        // config-file write hits ENOSPC) must settle the turn as failed and
        // release the retained node turn — never leak the count (which would
        // suppress this node's approval sweep for the rest of the run) nor
        // reject into the broker with an unbalanced ledger.
        let handle: AgentTurnHandle;
        let finish: () => NodeTurnResult;
        let endedAs: () => NodeOutcome;
        let retireCards: () => () => Promise<void>;
        // The silence window measures the CALLEE, so it starts when the
        // callee does — not when `call_agent` returned. Depth-1 calls queue
        // on a four-slot pool, so a fan-out's fifth call can sit here for
        // minutes before anything of its own could have been produced, and a
        // window armed at the call would report a callee that had not begun.
        this.callBroker.noteCalleeActivity(runId, callId);
        try {
          const graphNode = nodesById.get(callee.id);
          persistTurnStart(
            callee,
            callSessionKey(runId, conversationId),
            callId,
            member !== undefined && graphNode?.kind === 'agent'
              ? { stamp: graphNode, announce: first }
              : undefined,
          );
          ({ handle, finish, endedAs, retireCards } = await beginAgentTurn(
            callee,
            prompt,
            {
              callId,
              resumeSessionId,
              conversationId,
              ...(member !== undefined ? { poolMember: member } : {}),
            },
          ));
        } catch (err) {
          const recordSwept = releaseNodeTurn(callee.id)
            ? sweepApprovals(callee.id)
            : null;
          endConversationTurn(calleeCaller);
          const outcome: CalleeTurnOutcome = {
            status: 'failed',
            finalText: null,
            // geniro's own side: nothing about the work was wrong, so the
            // caller's right move is one retry.
            ...geniroSideFailure(
              `turn start failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
            sessionId: null,
          };
          const handedOn = handsOn?.(outcome, false) ?? false;
          enqueue(async () => {
            await recordSwept?.();
            // An attempt the pool hands on writes no ending: the call has
            // none yet, and a terminal row is what the transcript reads as
            // the call's own.
            if (handedOn) {
              return;
            }
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
          return { outcome, handedOn };
        }
        subTurns.set(callId, { handle, callee, conversationId });
        conversationNodes.set(calleeCaller, callee);
        await handle.done;
        // The result EXISTS from here on, while everything below — draining,
        // closing what the turn left out, possibly a whole compaction turn —
        // still holds the call open. A `cancel_agent` landing in that window
        // must not stamp its reason over finished work.
        //
        // Not yet for a FAILED attempt the pool may still hand on: until that
        // is decided the call has no result, and a cancel arriving meanwhile
        // must stop the hand-on rather than be told the work already finished.
        if (handsOn === null || endedAs() !== 'failed') {
          this.callBroker.noteCalleeTurnEnded(runId, callId);
        }
        // Compacted BEFORE the result is handed back: the call is still
        // active, so no continuation can open a turn on this conversation
        // while it runs — see `compactIfDue`.
        await drained();
        // The callee's own half of the same close — scoped to this CALL, so
        // a conversation's other calls keep whatever they still have out.
        const settledCall = finish();
        // Counted BEFORE that close, which states an ending for exactly the
        // delegates this is about: once it lands, the transcript says none
        // are out, while the work goes on inside the kept process.
        const delegatesStillOut =
          settledCall.outcome === 'completed'
            ? await delegatesOutOfCall(callId)
            : 0;
        // As the member that filled the window: the compaction is that
        // member's turn, not member 1's, and must leave member 1's row alone.
        await compactIfDue(
          callee,
          settledCall,
          {
            callId,
            conversationId,
            ...(member !== undefined ? { poolMember: member } : {}),
          },
          () => {},
        );
        return await new Promise<{
          outcome: CalleeTurnOutcome;
          handedOn: boolean;
        }>((resolve) => {
          enqueue(async () => {
            // Resolve in finally: a bookkeeping write failure must never
            // leave the broker's envelope pending (a sync caller would
            // hang and the run could never finish).
            let result: CalleeTurnOutcome = {
              status: 'failed',
              finalText: null,
              // geniro's own bookkeeping, not the callee: one retry is right.
              ...geniroSideFailure('callee bookkeeping failed'),
              sessionId: null,
            };
            let handedOn = false;
            try {
              // Another call (or the node's own turn) may still be live, and
              // then the node-wide sweep waits for it — this turn's cards do
              // not.
              const recordSwept = releaseNodeTurn(callee.id)
                ? sweepApprovals(callee.id)
                : retireCards();
              // A callee can itself be a caller: what ITS callees left this
              // conversation is drained to it — once its call has settled,
              // by continuing the conversation (`CallBroker.drainCaller`).
              endConversationTurn(calleeCaller);
              await recordSwept();
              subTurns.delete(callId);
              const { outcome, finalText, sessionId, error } = finish();
              const status =
                outcome === 'completed'
                  ? 'completed'
                  : outcome === 'cancelled'
                    ? 'cancelled'
                    : 'failed';
              result = {
                status,
                finalText,
                // The CLI's OWN sentence, classified by the CALLEE's adapter
                // — never a constant. This line read
                // `status === 'failed' ? 'callee turn failed' : null` for two
                // milestones, which is the whole subject of
                // `utils/callee-failure.ts`.
                ...(status === 'failed'
                  ? readCalleeFailure(error, (message) =>
                      this.adapterFor(callee.agent).failureFrom(message),
                    )
                  : { error: null, failureClass: null, resetsAt: null }),
                sessionId,
                ...(delegatesStillOut > 0 ? { delegatesStillOut } : {}),
              };
              handedOn = handsOn?.(result, settledCall.madeToolCalls) ?? false;
              // Decided before the ending is written, for the turn-start
              // catch's reason: a handed-on attempt's call has no ending yet.
              if (handedOn) {
                return;
              }
              if (handsOn !== null) {
                this.callBroker.noteCalleeTurnEnded(runId, callId);
              }
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
              // BEFORE this turn stops holding the run open: a result owed
              // to a caller that has ended wakes it, and that wake has to be
              // counted before the run can decide it is finished. Not for an
              // attempt the pool hands on — the call has no result yet.
              if (!handedOn) {
                this.callBroker.noteCalleeSettling(runId, callId);
              }
              resolve({ outcome: result, handedOn });
            }
          });
        });
      };

      liveSubTurns += 1;
      try {
        if (cancelRequested) {
          return cancelledOutcome;
        }
        // A call arriving after the walk is over — the caller's POST still in
        // flight through the finalization window, or its KEPT process waking on
        // a timer hours later — must not spawn a child nothing can reach: the
        // run's aggregate handle has settled, so neither Stop nor shutdown
        // would find it. This used to be answered by refusing the call
        // (`RUN_NOT_ACTIVE`); it is answered by WAKING the run instead, which
        // registers a handle again. A run that must not wake still refuses.
        if (runFinished) {
          const woke = await reopenRun();
          if (woke === 'superseded') {
            return supersededOutcome;
          }
          if (woke === 'stopped') {
            return cancelledOutcome;
          }
        }
        if (cancelledCalls.has(callId)) {
          return callerCancelledOutcome;
        }
        const releaseSlot = depth <= 1 ? await subTurnSlots.acquire() : null;
        try {
          if (cancelRequested || (runFinished && !reopened)) {
            return cancelledOutcome;
          }
          // Checked AGAIN after the slot: the whole point of the mark is the
          // call that waited in the pool while the caller changed its mind, and
          // a fan-out of five keeps that pool full for minutes.
          if (cancelledCalls.has(callId)) {
            return callerCancelledOutcome;
          }
          // The pool plan: the member `callee` already is, then the members a
          // failure another account could get past hands the call to.
          const attempts = [
            { member: pool?.member ?? 1, node: callee },
            ...(pool?.fallbacks ?? []),
          ];
          const skipped: PoolSkip[] = [];
          for (let index = 0; ; index += 1) {
            const attempt = attempts[index]!;
            const isLast = index === attempts.length - 1;
            const { outcome, handedOn } = await runAttempt(
              attempt.node,
              pool === undefined ? undefined : attempt.member,
              index === 0,
              index === 0
                ? message
                : poolHandOffPrompt(message, callMessages.get(callId) ?? []),
              // Only the first attempt continues a session: a fallback is
              // another account, which holds none of this conversation.
              index === 0 ? resumeSessionId : null,
              isLast
                ? null
                : (result, madeToolCalls) =>
                    !cancelRequested &&
                    !cancelledCalls.has(callId) &&
                    fallsThroughPool(result, madeToolCalls),
            );
            const reported: CalleeTurnOutcome =
              pool === undefined
                ? outcome
                : {
                    ...outcome,
                    member: attempt.member,
                    ...(skipped.length > 0 ? { poolSkipped: skipped } : {}),
                  };
            if (!handedOn) {
              callMessages.delete(callId);
              return reported;
            }
            const next = attempts[index + 1]!;
            skipped.push({
              member: attempt.member,
              failureClass: outcome.failureClass,
              error: outcome.error,
              resetsAt: outcome.resetsAt,
            });
            this.callBroker.noteCalleeHandedOn(runId, callId);
            // The next member runs under the same conversation key, and the
            // process this member left there must not serve it: a session
            // judges whether it fits a turn by its OWN CLI's key, which another
            // CLI's turn can match field for field.
            this.sessions.retire(
              callSessionKey(runId, conversationId),
              'its call was handed to another pool member',
            );
            enqueue(async () => {
              await persistItem(callee.id, 'system', null, {
                callId,
                severity: 'info',
                // The member now running the call, for the reader to name it
                // before the call settles — `call_started` names the first
                // member and only the settle names the one that answered.
                member: next.member,
                message: poolHandOffNotice(
                  callee.name ?? callee.id,
                  attempt.member,
                  next.member,
                  outcome,
                ),
              }).catch(() => {});
            });
          }
        } finally {
          releaseSlot?.();
        }
      } finally {
        liveSubTurns -= 1;
        enqueue(() => finishRunIfSettled());
      }
    };

    /**
     * Another turn for an agent whose own turn has already ended, while the run
     * is still live — how a follow-up reaches an agent the trigger feeds without
     * walking the graph again.
     *
     * It rides the node's OWN session key, so the process that agent's turn
     * kept takes it and the answer comes from inside the conversation it is
     * already in; a process the registry has since reaped is spawned again on
     * the session id this node reported. It is counted like a callee sub-turn —
     * outside the walk's denominator, holding the run open while it lasts —
     * because it is not a step of the walk: the node already has its outcome,
     * and whatever runs downstream of it has consumed that.
     */
    const continueNode = async (
      node: WorkflowAgentNode,
      prompt: string,
      images: TurnImage[],
    ): Promise<void> => {
      const starting = reserveContinuation(node.id);
      markRootWorking(node.id, true);
      liveSubTurns += 1;
      retainNodeTurn(node.id);
      retainConversation(node.id);
      persistTurnStart(node, nodeSessionKey(runId, node.id));
      let handle: AgentTurnHandle;
      let finish: () => NodeTurnResult;
      let retireCards: () => () => Promise<void>;
      try {
        ({ handle, finish, retireCards } = await beginAgentTurn(
          node,
          prompt,
          undefined,
          {
            images,
            resumeSessionId:
              nodeSessionIds.get(node.id) ??
              run.resumeSessions.get(node.id) ??
              null,
          },
        ));
      } catch (err) {
        startingContinuations.delete(node.id);
        starting.release();
        markRootWorking(node.id, false);
        const lastTurn = releaseNodeTurn(node.id);
        const recordSwept = lastTurn ? sweepApprovals(node.id) : null;
        endConversationTurn(node.id);
        followUpFailed = true;
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
          liveSubTurns -= 1;
          await finishRunIfSettled();
        });
        return;
      }
      startingContinuations.delete(node.id);
      continuationHandles.set(node.id, handle);
      starting.release();
      void handle.done.then(async () => {
        await drained();
        const settledTurn = finish();
        await compactIfDue(node, settledTurn, undefined, () => {
          compactingNodes.add(node.id);
        });
        enqueue(async () => {
          const recordSwept = releaseNodeTurn(node.id)
            ? sweepApprovals(node.id)
            : retireCards();
          endConversationTurn(node.id);
          await recordSwept();
          continuationHandles.delete(node.id);
          const { outcome } = finish();
          if (outcome === 'failed') {
            followUpFailed = true;
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
          } catch (err) {
            persistenceFailed = true;
            this.logger.error(
              `workflow run ${runId} node ${node.id} follow-up bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            compactingNodes.delete(node.id);
            markRootWorking(node.id, false);
            liveSubTurns -= 1;
            await finishRunIfSettled();
          }
        });
      });
    };

    /** Write a user message row on the serialized chain and hand it back. */
    const persistUserMessage = (
      nodeId: string | null,
      payload: unknown,
    ): Promise<ItemWire> =>
      new Promise<ItemWire>((resolve, reject) => {
        enqueue(async () => {
          try {
            resolve(await persistItem(nodeId, 'message', 'user', payload));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });

    /**
     * A follow-up for this LIVE run: the agents the trigger feeds get it, as
     * though the trigger had fired again — `GraphExecutorService.sendMessage`
     * holds the settled half.
     *
     * An agent mid-turn is told through its CLI's own mid-turn channel, the one
     * a chat's follow-up rides; an idle one is given another turn on its kept
     * process. Null once the run has finished, which hands the message back to
     * be walked from the trigger instead.
     */
    const releaseWaitsFor = (
      node: WorkflowAgentNode,
      /** The conversation the message went into — its own, unless named. */
      conversationId: string | null = null,
    ): void => {
      // A message delivered into a turn that is blocked in `await_agent` (or a
      // sync `call_agent`) is read by the CLI only once that tool call returns,
      // so the wait is released and the caller answers the user now. Not on a
      // CLI whose follow-up INTERRUPTS: its new prompt already replaces the
      // one waiting, and no consumption report would ever clear the mark left
      // for a wait that has not started.
      if (!this.adapterFor(node.agent).getConfig().followUp.interrupts) {
        this.callBroker.interruptWaits(
          runId,
          callerKey(node.id, conversationId),
        );
      }
    };

    /**
     * The handle of the turn `caller` is speaking in right now — the node's own
     * DAG turn or follow-up for its own conversation, or the callee sub-turn
     * of the call its conversation is answering — or null when it has none.
     */
    const conversationHandle = (caller: string): AgentTurnHandle | null => {
      const nodeId = callerNodeOf(caller);
      const conversationId = callerConversationOf(caller);
      if (conversationId === null) {
        return (
          continuationHandles.get(nodeId) ?? runningHandles.get(nodeId) ?? null
        );
      }
      for (const turn of subTurns.values()) {
        if (
          turn.callee.id === nodeId &&
          turn.conversationId === conversationId
        ) {
          return turn.handle;
        }
      }
      return null;
    };

    const deliverFollowUp = async (
      text: string,
      images: SendMessageImage[],
    ): Promise<ItemWire | null> => {
      // A pass that is over hands the message back to be walked from the
      // trigger — unless the run is AWAKE for work its own agents started
      // (`reopenRun`), which holds the run's claim a new walk would need. Then
      // the message is delivered here, exactly as into a live pass.
      if (runFinished && !reopened) {
        return null;
      }
      // RUN_BUSY, which the renderer queues on and drains when a turn ends.
      const busy = (why: string): ConflictException =>
        new ConflictException(
          'RUN_BUSY',
          `${why} — your message goes out once it has`,
        );
      if (cancelRequested) {
        throw busy('this run is stopping');
      }
      const roots = nodes.filter(
        (node): node is WorkflowAgentNode =>
          node.kind === 'agent' && triggerFed.has(node.id),
      );
      // A root the node cap has held back has no conversation to carry on yet,
      // and its own turn is about to start from the seed.
      if (
        roots.some(
          (root) =>
            (!settled.has(root.id) && !runningHandles.has(root.id)) ||
            startingContinuations.has(root.id),
        )
      ) {
        throw busy('the workflow is still starting');
      }
      // Never delivered into a compaction: on a CLI whose compaction replaces
      // the session, a message landing in it would be summarised away.
      const compactingRoot = roots.find((root) => compactingNodes.has(root.id));
      if (compactingRoot) {
        throw busy(
          `${compactingRoot.name ?? compactingRoot.id} is compacting its conversation`,
        );
      }
      const { stored, turnImages } = this.storeImages(runId, images);
      for (const root of roots) {
        const running =
          runningHandles.get(root.id) ?? continuationHandles.get(root.id);
        // Told FIRST, recorded after: only a delivery the CLI confirmed may be
        // written to the transcript — the reverse leaves a message on screen
        // that no agent received.
        if (running && !running.sendUserMessage({ text, images: turnImages })) {
          throw busy(`${root.name ?? root.id} is finishing a turn`);
        }
      }
      // The roots this message will START a turn for are counted live from
      // NOW, across the write below: on an awake run the woken work can drain
      // during it, and the wake would then settle — status written back, claim
      // released — under a turn that is about to begin.
      const starting = roots
        .filter(
          (root) =>
            !runningHandles.has(root.id) && !continuationHandles.has(root.id),
        )
        .map((root) => ({ root, reservation: reserveContinuation(root.id) }));
      liveSubTurns += starting.length;
      let item: ItemWire;
      let persisted = false;
      try {
        item = await persistUserMessage(null, messagePayload(text, stored));
        persisted = true;
      } finally {
        liveSubTurns -= starting.length;
        if (!persisted) {
          for (const { root, reservation } of starting) {
            startingContinuations.delete(root.id);
            reservation.release();
          }
        }
      }
      for (const root of roots) {
        if (!runningHandles.has(root.id) && !continuationHandles.has(root.id)) {
          continueNode(root, text, turnImages);
        } else {
          releaseWaitsFor(root);
        }
      }
      // A turn that could not be started leaves nothing live to settle the
      // wake, so the check the reservation above deferred is made here.
      await finishRunIfSettled();
      return item;
    };

    /**
     * A message from the user to the callee of ONE running call — the direct
     * line past the caller. It goes through the CLI's mid-turn channel, so the
     * callee answers inside the work it was briefed for and its result still
     * goes back to the caller.
     *
     * Refused rather than re-routed once the call is not running: a settled
     * callee has no turn to join and nobody waiting on its answer, and text
     * meant for one agent must not reach another. The row carries the callee's
     * node id and the call id, which files it inside that call's block.
     *
     * The addressed node must match the call's callee: call ids are numbered
     * per PASS of a run, so a block left reading "running" by an earlier pass
     * can name an id a later pass gave to a different agent.
     */
    const deliverToCall = async (
      nodeId: string,
      callId: string,
      text: string,
      images: SendMessageImage[],
    ): Promise<ItemWire> => {
      const subTurn = subTurns.get(callId);
      if (
        subTurn === undefined ||
        subTurn.callee.id !== nodeId ||
        cancelRequested
      ) {
        throw callNotRunning();
      }
      const { handle, callee, conversationId } = subTurn;
      const { stored, turnImages } = this.storeImages(runId, images);
      // Told FIRST, recorded after, for `deliverFollowUp`'s reason.
      if (!handle.sendUserMessage({ text, images: turnImages })) {
        throw new ConflictException(
          'CALL_MESSAGE_REFUSED',
          `${callee.name ?? callee.id} can't take a message while it works — its CLI accepts none mid-turn, or the turn is ending`,
        );
      }
      noteCallMessage(callId, text);
      // A callee that is itself a caller may be waiting on ITS callees — in
      // the conversation this call speaks in.
      releaseWaitsFor(callee, conversationId);
      return persistUserMessage(callee.id, {
        ...messagePayload(text, stored),
        nodeId: callee.id,
        callId,
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
        for (const node of dagNodes) {
          if (
            settled.has(node.id) ||
            runningHandles.has(node.id) ||
            startingDagNodes.has(node.id)
          ) {
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
            if (
              runningHandles.size + startingDagNodes.size >=
              this.parallelism
            ) {
              // Concurrency cap reached — leave the node ready; the
              // schedule() pass each settling node fires launches it later.
              continue;
            }
            void launchNode(node);
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

    // Every call-capable agent needs a token whether or not it calls anyone —
    // the board and render tools ride the same endpoint.
    //
    // ONCE per run, not per pass, for the reason the callers' loop below
    // states — and this loop is where that rule was broken. It re-minted on
    // every pass, and because it runs FIRST, its fresh token is the one the
    // callers' loop then found already present and left alone: so on a task
    // run, which is every run started from the board, a Manager's kept process
    // was locked out of its own endpoint by the second message the user sent.
    // REPORTED as `call_agent` and `get_task` both answering 403 FORBIDDEN in a
    // thread that had been calling its team all morning; reconstructed from the
    // daemon log, where four passes 20 seconds apart re-minted four times and
    // every tool call after the first of them was refused by the guard.
    //
    // Every call-capable agent, not only a board task's — see `holdsEndpoint`.
    for (const node of nodes) {
      if (node.kind === 'agent' && callCapable(node)) {
        this.callTokens.ensure(runId, node.id);
      }
    }
    this.registerArtifactPublishers(
      runId,
      nodes
        .filter(
          (node): node is WorkflowAgentNode =>
            node.kind === 'agent' && callCapable(node),
        )
        .map((node) => node.id),
      persistItem,
      // The call a node is answering, when exactly one is live on it — so a
      // callee's page lands inside its call block, as every other row of that
      // call does. Two at once cannot be told apart from here, and a card
      // filed under the wrong call reads exactly like a right one, so that
      // case stays unattributed.
      //
      // And only when that call is the node's ONLY live turn: a callable DAG
      // node can hold its own turn (or a continuation) beside a callee turn,
      // and a page published from its own turn would otherwise be stamped with
      // the call's id and filed inside a block it has nothing to do with.
      // `liveTurnsByNode` counts every kind of turn a node holds, callee
      // sub-turns included.
      (nodeId) => {
        const live = [...subTurns]
          .filter(([, turn]) => turn.callee.id === nodeId)
          .map(([callId]) => callId);
        return live.length === 1 && liveTurnsByNode.get(nodeId) === 1
          ? (live[0] ?? null)
          : null;
      },
    );
    /** The node a caller conversation runs as — its pool member, once known. */
    const agentNodeOfConversation = (
      caller: string,
    ): WorkflowAgentNode | null => {
      const ran = conversationNodes.get(caller);
      if (ran !== undefined) {
        return ran;
      }
      const node = nodesById.get(callerNodeOf(caller));
      return node?.kind === 'agent' ? node : null;
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
        // ONCE per run, not per pass: a caller's process is kept between passes
        // and presents the token it spawned with, so a fresh one here would
        // lock a reused Manager out of its own team. Revoked by the teardown.
        // The idempotence lives in the registry (`ensure`) rather than in a
        // `get(...) === null` guard here, because the guard beside it is what
        // one of the two loops forgot.
        if (caller?.kind === 'agent' && callCapable(caller)) {
          this.callTokens.ensure(runId, callerId);
        }
      }
      this.callBroker.registerRun(
        runId,
        {
          calleesOf,
          launchCalleeTurn,
          persistItem: (nodeId, kind, role, payload) => {
            enqueue(async () => {
              await persistItem(nodeId, kind, role, payload);
            });
          },
          isCancelled: () => cancelRequested,
          isSuperseded: supersededByNextPass,
          toolCallDeadlineMs: (caller) => {
            const node = agentNodeOfConversation(caller);
            return node !== null
              ? this.adapterFor(node.agent).getConfig().mcp.toolCallDeadlineMs
              : null;
          },
          cancelCalleeTurn: (callId) => {
            cancelledCalls.add(callId);
            const subTurn = subTurns.get(callId);
            subTurn?.handle.cancel();
            return subTurn !== undefined;
          },
          messageCallee: (callId, text) => {
            const subTurn = subTurns.get(callId);
            if (subTurn === undefined || cancelRequested) {
              return { delivered: false, reason: 'not_started' };
            }
            const { handle, callee, conversationId } = subTurn;
            if (!handle.sendUserMessage({ text, images: [] })) {
              return { delivered: false, reason: 'refused' };
            }
            noteCallMessage(callId, text);
            // `deliverToCall`'s reason: a callee that is itself a caller may be
            // blocked waiting on ITS callees, and would read this only then.
            releaseWaitsFor(callee, conversationId);
            return {
              delivered: true,
              interrupts: this.adapterFor(callee.agent).getConfig().followUp
                .interrupts,
            };
          },
          // Per CONVERSATION: a node's callee turns say nothing about whether
          // its own conversation — or another call's — has a turn to answer in.
          isNodeLive: (caller) => liveConversations.has(caller),
          tellLiveNode: (caller, prompt) => {
            const node = agentNodeOfConversation(caller);
            if (
              node === null ||
              cancelRequested ||
              runFinished ||
              !liveConversations.has(caller) ||
              this.adapterFor(node.agent).getConfig().followUp.interrupts
            ) {
              return false;
            }
            // Into the turn of THAT conversation — for a callee, the sub-turn
            // of the call it is answering, which the node-wide lookup this
            // replaced never reached, so a question for a working callee was
            // pushed nowhere and timed out.
            return (
              conversationHandle(caller)?.sendUserMessage({
                text: prompt,
                images: [],
              }) ?? false
            );
          },
          wakeNode: (caller, prompt) => {
            const nodeId = callerNodeOf(caller);
            const node = nodesById.get(nodeId);
            // A node's OWN conversation only: a callee conversation has no turn
            // outside the calls it answers, and the broker continues it as a
            // call instead (`CallBroker.startOwnerTurn`). Waking the NODE for it
            // opened the wrong conversation, in a process with none of the
            // call's context.
            if (callerConversationOf(caller) !== null) {
              return false;
            }
            // `runFinished` is NOT a refusal any more, and this is the other
            // half of `reopenRun`: callers are steered to call ASYNC, end the
            // turn and expect to be started again, so a Manager that dispatched
            // after waking would otherwise never be told its Engineer had
            // finished. The wake itself is decided below, where it can await.
            if (node?.kind !== 'agent' || cancelRequested) {
              return false;
            }
            // Counted as live from NOW rather than from when the turn begins:
            // the turn starts on the write chain, and a finalizer queued ahead
            // of it would otherwise see nothing live and close the run under
            // the wake.
            liveSubTurns += 1;
            const deliverWake = async (): Promise<void> => {
              const starting = startingContinuations.get(nodeId);
              if (starting) {
                // The reservation may depend on a later write in this chain.
                void starting.ready.then(() => enqueue(deliverWake));
                return;
              }
              liveSubTurns -= 1;
              // Cancelled meanwhile — every callee dies with the run, so there
              // is nothing left for this turn to answer or collect — or the
              // walk is over and the run refuses to wake (stopped, archived,
              // being deleted).
              if (
                cancelRequested ||
                (runFinished && (await reopenRun()) !== 'awake')
              ) {
                await finishRunIfSettled();
                return;
              }
              if (liveConversations.has(caller)) {
                // A follow-up raced the wake and the conversation is working
                // again: hand it the message inside that turn rather than
                // opening a second one on it. Asked of the CONVERSATION: a node
                // "live" only through a callee turn has no handle here, and the
                // prompt its wake was already counted as told went nowhere.
                conversationHandle(caller)?.sendUserMessage({
                  text: prompt,
                  images: [],
                });
                // This path opens NO turn, so nothing else would put a run that
                // woke for this wake back to sleep.
                await finishRunIfSettled();
                return;
              }
              continueNode(node, prompt, []);
            };
            enqueue(deliverWake);
            return true;
          },
        },
        // What an earlier pass of this run left in the transcript — null on the
        // first pass. Read at follow-up time, where the transcript is read for
        // the node sessions too.
        run.callSeed,
      );
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

    // Ahead of the seed, because these are facts about the run's CONFIGURATION
    // rather than about anything an agent did: a node named a setting its CLI
    // cannot honour. The value is dropped either way (see
    // `withResolvedNodeSettings`) — this is what stops the drop being silent
    // for a workflow that arrived as YAML, where the builder never had the
    // chance to refuse the field.
    for (const setting of dropped) {
      enqueue(async () => {
        await persistItem(null, 'system', null, {
          message:
            `'${setting.name}' names ${setting.setting} (${setting.value}) ` +
            `that will be ignored: ${setting.reason}`,
        });
      });
    }
    // Seed message first, then the roots fan out — unless this pass carries a
    // follow-up, whose row the route has already written.
    if (!run.seedPersisted) {
      enqueue(async () => {
        await persistItem(
          null,
          'message',
          'user',
          messagePayload(seedPrompt, run.seedAttachments),
        );
      });
    }
    liveControl = { deliver: deliverFollowUp, deliverToCall };
    this.liveRuns.set(runId, liveControl);
    // No per-machine gate can shut a caller out any more: every adapter hands
    // its own CLI the endpoint in-protocol, so having outgoing call edges is
    // the whole admission predicate. The M3 "probe verdict shut this caller
    // out" system item went with the probe.
    schedule();
  }

  /**
   * Probe the run's own MCP route with a JSON-RPC initialize (3s cap) and
   * report a failure through `onFailure`. Fire-and-forget: the DAG walk never
   * waits on it. No call-capable caller → nothing to check.
   */
  private selfCheckCallEndpoint(
    caller: WorkflowAgentNode | null,
    mcpEndpointFor: (
      node: WorkflowAgentNode,
    ) => { url: string; token: string } | null,
    onFailure: (message: string) => void,
  ): void {
    if (!caller) {
      return;
    }
    const endpoint = mcpEndpointFor(caller);
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
