import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import {
  type AgentKind,
  isTerminalRunStatus,
  type ItemKind,
  type RunStatus,
} from '../../runs/runs.types';
import type { AgentEvent } from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { ClaudeProbeService } from '../adapters/claude/claude-probe.service';
import {
  type AttachmentDataWire,
  CHAT_DEFAULT_APPROVAL,
  type ChatApprovalMode,
  type ClaudeModesCapability,
  type ItemWire,
  type RunWire,
  type SendMessageImage,
  SINGLE_AGENT_NODE,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import {
  answerFoldsInto,
  foldApprovalAnswer,
  isUserQuestion,
} from '../utils/approval-answer';
import {
  closesADelegate,
  mapEventToItem,
  offTurnActivity,
  terminalStatus,
} from '../utils/event-to-item';
import { persistItemAndEmit, runToWire } from '../utils/persist-item';
import { resolveValidConfigDir } from '../utils/resolve-config-dir';
import { resolveValidCwd } from '../utils/resolve-cwd';
import { assertChatRun } from '../utils/run-kind';
import { type RunStatusAnnounce, writeRunStatus } from '../utils/run-status';
import { createSessionIdSaver } from '../utils/session-saver';
import { unanswerablePayload, unansweredRequests } from '../utils/unanswerable';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { ApprovalRegistry } from './approval-registry';
import { AttachmentStoreService } from './attachment-store.service';
import { CliSessionsService } from './cli-sessions.service';
import { EffortsService } from './efforts.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { McpHarvestStore } from './mcp-harvest.store';
import { PartialStreamService } from './partial-stream.service';
import { ProcessRegistry } from './process-registry';
import { RunGroupsService } from './run-groups.service';
import { RunTeardownService } from './run-teardown.service';
import { SkillHarvestStore } from './skill-harvest.store';

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * How long one row from a DELEGATE keeps a settled run reading `running` — see
 * {@link ChatService.leaseOnDelegateRow}.
 *
 * A lease and not a latch, because a delegate has no terminal event of its own
 * to take the badge down with: its launching `Task` call returned long ago, and
 * a delegate that simply stops has nothing left to say. So the claim expires
 * unless the delegate renews it by producing another row.
 *
 * The window is a bet in BOTH directions and the length is where the two costs
 * balance. Too short and a delegate parked in one slow tool call (a test suite,
 * a long grep) drops the badge back to `completed` while it is demonstrably
 * mid-work — the defect this exists to remove. Too long and a delegate that has
 * genuinely finished leaves `still working` on screen for the rest of the
 * window, which is the same complaint arriving from the other side ("агент
 * вроде как закончил работать, а он статуса не изменил"). Five minutes bridges
 * every delegate tool call observed here while bounding the wrong-direction
 * claim to something a user can outwait; it is deliberately far short of the
 * 30-minute silence deadline `spawn-cli` gives a turn, because that deadline
 * decides whether to ABANDON work and this one only decides a word.
 *
 * The happy path never reaches it: a delegate that reports back makes the CLI
 * open a continuation turn of its own, and that turn's own `result` settles the
 * run through {@link ChatService.restatusAfterOffTurnEvent}.
 */
const DELEGATE_ROW_LEASE_MS = 5 * 60 * 1000;

/**
 * Orchestrates a single-agent chat: validates the run's cwd, drives the chosen
 * adapter, and applies **persist-then-emit** — every item is written (allocating
 * its monotonic seq) BEFORE it is published on the bus, so the durable
 * transcript is the source of truth and a reconnecting client can replay it. The
 * CLI session id is captured into `node_state` for `--resume`.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  /**
   * Each in-flight turn's FINALIZER, keyed by run — not its handle.
   *
   * A turn's writes do not stop when its child exits: `handle.done` resolves,
   * and the finalizer chained onto it then drains the persist queue, sweeps
   * pending approvals and records the terminal item. Awaiting `handle.done`
   * would NOT wait for any of that — the finalizer is a continuation on the
   * same promise, so it merely runs first and suspends at its own first await,
   * letting the awaiting caller resume underneath it. `delete` therefore waits
   * on this, or the rows it destroys get rewritten a moment later.
   */
  private readonly finalizing = new Map<string, Promise<void>>();

  /**
   * Runs whose delete is in progress.
   *
   * `finalizing` only covers a turn that reached `adapter.start()`. Between
   * `tryClaim` and `register` a turn is CLAIMED but has no finalizer yet, and
   * that window contains real awaits (the approval-mode probe, the
   * live-stream `--version` check). A delete landing there would wait for
   * nothing, destroy the rows, and let the turn register and finalize
   * afterwards — writing exactly the orphans the wait exists to prevent. So a
   * turn crossing that window checks here instead and gives up.
   */
  private readonly deleting = new Set<string>();

  /**
   * How a mid-turn approval change reaches the turn in flight, keyed by run.
   *
   * Set when a turn registers, dropped when it settles. Returns whether the
   * change was DELIVERED — an entry existing only means a turn is running, not
   * that it can be re-moded (a claude turn spawned under
   * `--dangerously-skip-permissions` has no permission dialogue to be told
   * through, and answers false).
   *
   * A function rather than the handle itself because two things must move
   * together: the CLI's own mode, and the `approvalMode` the turn's closure
   * reads at its auto-approve seam. Handing callers the handle would let them
   * move one without the other.
   */
  private readonly liveApproval = new Map<
    string,
    (mode: ChatApprovalMode) => boolean
  >();
  /**
   * The approval posture each run's KEPT PROCESS should be judged by right
   * now, including while no turn is running.
   *
   * Separate from the per-turn `approvalMode` because the two have genuinely
   * different lifetimes: a turn's copy dies with the turn, while the CLI
   * process lives on and can raise a permission request at any point in
   * between. Reading a turn-scoped copy there answered with whatever the LAST
   * turn was started under — so a user who ended a turn and then moved the chip
   * to `ask` still had the next between-turn tool call approved in their name,
   * with no card. `liveApproval` cannot cover that window by construction: it
   * is registered per turn and only consulted while one is in flight.
   *
   * Written on every turn start and by `updateSettings` whichever path it
   * takes; dropped when the run's session is torn down.
   */
  private readonly runPosture = new Map<string, ChatApprovalMode | undefined>();

  /**
   * Runs whose `running` badge was put there by an OFF-TURN row rather than by
   * a turn of ours — see {@link restatusAfterOffTurnEvent}.
   *
   * A set and not a boolean on the run row: this is a fact about who last wrote
   * the status in THIS process, which the row cannot carry (a restart has no
   * off-turn continuation to finish, and would read a stale flag as one).
   * Cleared when the continuation settles and whenever a real turn takes the
   * run over.
   */
  private readonly offTurnRuns = new Set<string>();

  /**
   * Runs whose off-turn `running` is a LEASE on a delegate that is still
   * producing rows, with the status to hand back when it stops — see
   * {@link leaseOnDelegateRow}.
   *
   * A subset of {@link offTurnRuns} rather than a parallel plane: the badge
   * belongs to the same off-turn continuation either way, so the CLI's own
   * continuation turn settles it exactly as it settles a main-thread one. What
   * this map adds is the only thing that set cannot carry — the expiry, and the
   * status the run was wearing before the lease took it.
   */
  private readonly delegateLeases = new Map<
    string,
    { timer: NodeJS.Timeout; restoreTo: RunStatus }
  >();

  /**
   * Runs whose lease is being TAKEN right now — claimed synchronously, before
   * the read that decides whether to take it.
   *
   * The map alone cannot express this. Off-turn events are dispatched
   * fire-and-forget, so two delegate rows parsed from one stdout chunk run
   * {@link leaseOnDelegateRow} concurrently: both find the map empty, both
   * `await` the run, and the second `set` overwrites the first entry —
   * orphaning a timer nothing can refresh or clear, which then hands the badge
   * back mid-work five minutes later however many rows kept arriving. Claiming
   * the key before the first `await` is what makes the second caller see the
   * lease that is on its way, the same single-flight discipline
   * `EffortsService`/`SkillsService` use for their reads.
   *
   * {@link clearDelegateLease} drops a claim as well as a lease, so a real turn
   * taking the badge over cancels one that has not landed yet — otherwise the
   * in-flight caller would install a lease over the top of it.
   *
   * A TOKEN per acquisition rather than a bare run id, because presence alone
   * cannot answer "is this still MY claim". A takeover between one caller's
   * read and its install drops that claim, and a later row may have claimed the
   * key again in the meantime — so the resuming caller has to compare identity,
   * or it reads the newcomer's claim as its own, installs over the turn that
   * just took the badge, and leaves `offTurnRuns` latched on a run a real turn
   * owns.
   */
  private readonly leaseClaims = new Map<string, symbol>();

  /**
   * Runs whose off-turn `running` flip is in flight — the same claim, for
   * {@link restatusAfterOffTurnSignal}.
   *
   * Separate from {@link leaseClaims} because the two decide different things:
   * a delegate's row takes a lease with an expiry, a main-thread delta takes
   * the latch that a terminal event ends. Sharing one set would let a delta in
   * flight swallow a delegate row's lease, leaving the latch on with nothing to
   * take it down.
   */
  private readonly offTurnSignalClaims = new Set<string>();

  /**
   * Per run, the delegates the CLI has told us are FINISHED — by launching
   * tool-call id, the same key their block is drawn under.
   *
   * The one fact that separates a delegate's trailing rows from a delegate that
   * is still working, and neither the row itself nor its timing can supply it:
   * both are `parentToolUseId` rows arriving after the turn settled. A delegate
   * the CLI brackets (`task_started` → `task_updated`) reports its own end, and
   * `spawn-cli` relays that as the `backgroundOpen: false` announcement that
   * closes the block; one it never brackets reports nothing, which is exactly
   * the case whose steps go on arriving under a `completed` badge. So a row
   * from a delegate named here restates nothing, and a row from one that is not
   * takes a lease — see {@link leaseOnDelegateRow}.
   */
  private readonly closedDelegates = new Map<string, Set<string>>();

  /**
   * Runs whose turn is HELD for background work, and by how many units.
   *
   * In memory and per run, exactly like the approval registry the `awaiting`
   * reading comes from, and on the run's WIRE row for exactly the same reason:
   * the hold begins with one broadcast and then lasts as long as the delegates
   * do. A window opened — or a chat revisited — after that broadcast has
   * nothing else to read it off, and would put the user's next message into a
   * queue that will not drain for minutes.
   */
  private readonly heldRuns = new Map<string, number>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly bus: AgentEventBus,
    private readonly registry: ProcessRegistry,
    private readonly sessions: AgentSessionRegistry,
    private readonly approvals: ApprovalRegistry,
    private readonly adapters: AgentAdapterRegistry,
    private readonly claudeProbe: ClaudeProbeService,
    private readonly skillHarvest: SkillHarvestStore,
    private readonly mcpHarvest: McpHarvestStore,
    private readonly attachments: AttachmentStoreService,
    private readonly partials: PartialStreamService,
    private readonly teardown: RunTeardownService,
    private readonly efforts: EffortsService,
    private readonly seqs: ItemSeqAllocator,
    private readonly groups: RunGroupsService,
    private readonly cliSessions: CliSessionsService,
  ) {}

  /**
   * One attachment's bytes for the renderer, base64 in JSON — an `<img src>`
   * cannot carry the bearer token every daemon route demands, so the transcript
   * fetches through the generated client and builds a data URL.
   */
  readAttachment(runId: string, attachmentId: string): AttachmentDataWire {
    const { mediaType, bytes } = this.attachments.read(runId, attachmentId);
    return { id: attachmentId, mediaType, data: bytes.toString('base64') };
  }

  /**
   * Reconcile chat runs left `running` by a crash / SIGKILL / daemon restart
   * mid-turn. The in-process finalizer and the graceful-SIGTERM shutdown hook are
   * the only paths that flip a turn to a terminal status, and the UI's SIGKILL
   * escalation bypasses both — so a killed daemon leaves the run permanently
   * `running` with a dangling non-terminal transcript. On boot, any `running`
   * chat run with no live registry handle is closed: a synthetic terminal `error`
   * item so the transcript doesn't dangle, and the run is marked `failed`.
   *
   * Called from `main.ts` AFTER the schema sync (not via an OnApplicationBootstrap
   * hook, which fires before the additive `schema.update` and would query tables
   * that don't exist yet on a fresh install).
   */
  async reconcileOrphanedRuns(): Promise<void> {
    try {
      const em = this.em.fork();
      const stale = await this.runDao.listRunningChats(em);
      let reconciled = 0;
      for (const run of stale) {
        if (this.registry.has(run.id)) {
          continue; // an in-flight turn legitimately owns this run
        }
        await this.persist(
          em,
          run.id,
          await this.seqs.reserve(run.id),
          'error',
          null,
          {
            message:
              'run interrupted — the daemon stopped before this turn finished',
          },
        );
        // The kill took the in-memory registry with it, so no settle path ever
        // swept these — without this the cards come back looking answerable.
        for (const request of unansweredRequests(
          await this.itemDao.getByRun(run.id, -1, em),
        )) {
          await this.persist(
            em,
            run.id,
            await this.seqs.reserve(run.id),
            'unanswerable',
            null,
            request.payload,
          );
        }
        await this.setRunStatus(em, run.id, 'failed');
        reconciled += 1;
      }
      if (reconciled > 0) {
        this.logger.warn(
          `reconciled ${reconciled} orphaned running chat run(s) to failed on boot`,
        );
      }
    } catch (err) {
      // Best-effort cleanup — never block daemon boot (e.g. a fresh DB whose
      // schema sync hasn't created the tables yet has nothing to reconcile).
      this.logger.error(
        `boot reconcile of orphaned running runs failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Write a run's status AND announce it.
   *
   * One helper rather than a `runDao.updateById` at each of the seven places a
   * status is written: the announcement is what keeps a background run's badge
   * honest, and a write that forgot to announce would go stale invisibly —
   * exactly the failure this replaces. Announce-after-write, so no client can
   * observe a status the database does not yet have.
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

  private announceActivity(runId: string, activity: string | null): void {
    this.bus.publishRunStatus({ runId, status: null, activity });
  }

  /**
   * Announce that the turn is now (or is no longer) merely HELD for background
   * work the agent started.
   *
   * The count rides as a FACT beside the phrase, not only inside it. The
   * composer has to act on this — while a run is held the agent is idle and a
   * message must go straight out rather than into the queue — and reading that
   * decision off the wording of an English sentence is how a UI comes to break
   * when someone improves the copy.
   */
  private announceRunHold(
    runId: string,
    open: number,
    activity: string | null,
  ): void {
    if (open > 0) {
      this.heldRuns.set(runId, open);
    } else {
      this.heldRuns.delete(runId);
    }
    this.bus.publishRunStatus({
      runId,
      status: null,
      activity,
      holdingFor: open,
    });
  }

  /**
   * Announce that a run has become parked on the user — or stopped being.
   *
   * Separate from {@link announceActivity} because the two say different
   * things and only one of them belongs on a tool call. The activity phrase is
   * the sentence under the badge; this is the badge, and the badge must not
   * read "running" while nothing can move without the user.
   *
   * Always read back OUT of the registry rather than passed in as the kind that
   * just changed: a turn can hold several cards at once, so "this one closed"
   * is not "nothing is open". Answering from the map is what keeps a second
   * open question from being cleared by the first one's verdict.
   *
   * It carries no activity PHRASE, deliberately — the kind is the whole fact,
   * and the sentence under the badge is worded by the renderer from it. The
   * daemon used to send "waiting for your answer" here as an activity string,
   * which read fine live and then vanished on a reload: the activity plane is
   * events-only, so a reconnecting window had the badge (which rides the run
   * row) with nothing under it. One authority for the fact, one place that
   * words it, and both surfaces agree whenever they are drawn.
   *
   * Clearing the activity is also correct rather than incidental: whatever the
   * run was last said to be DOING, it is not doing it while it waits.
   *
   * What is NOT correct is leaving it cleared once the wait ENDS, which is what
   * {@link resumedActivity} is for. The approved tool then runs with nothing
   * naming it — the phrase is only ever written by a `tool_call`, and the call
   * the user just approved had already announced itself BEFORE the card went
   * up. Measured on a real `ask` turn: a 30s command approved by hand ran under
   * "Working… 11s" from the moment Approve was pressed. That is the reported
   * "the line does not match the work" again, on the commonest path there is.
   * Used only when nothing is still awaiting — a second open card means the run
   * is still parked and the phrase must stay down.
   */
  private announceAwaiting(
    runId: string,
    resumedActivity: string | null = null,
  ): void {
    const awaiting = this.approvals.awaitingFor(runId);
    this.bus.publishRunStatus({
      runId,
      status: null,
      activity: awaiting === null ? resumedActivity : null,
      awaiting,
    });
  }

  async createChat(input: {
    agentKind: AgentKind;
    cwd: string;
    model?: string;
    title?: string;
    approval?: ChatApprovalMode;
    effort?: string;
    configDir?: string;
    /**
     * The app's global custom instructions as they stand right now. Snapshotted
     * onto the row below, so a later edit reaches the next chat and not this
     * one — see {@link Run.customInstructions} for why that is deliberate.
     */
    customInstructions?: string;
    /**
     * A conversation this CLI already holds, taken over instead of started —
     * the new thread resumes it, and opens on the transcript it already had.
     */
    resumeSessionId?: string;
  }): Promise<RunWire> {
    const cwd = resolveValidCwd(input.cwd);
    this.assertApprovalSupported(input.agentKind, input.approval);
    this.assertEffortSupported(
      input.agentKind,
      input.effort ?? null,
      input.model ?? null,
    );
    // Canonicalized HERE, at the one moment the value is chosen, so the row
    // holds the path that was actually checked — the same contract `cwd` above
    // has. Each turn re-resolves it anyway (a directory can be deleted between
    // creation and a turn), which is what keeps a vanished profile from
    // reaching the child, where claude would CREATE it and report a login
    // failure about a directory nobody meant to name.
    const configDir = this.resolveConfigDir(input.agentKind, input.configDir);
    // Which sidebar group claims a chat opened in this folder. Resolved HERE
    // rather than by the caller so the rule holds for every chat the daemon
    // creates, and against the CANONICAL cwd above rather than the one the
    // request spelled — a group's folder is canonical too, so a symlinked path
    // matches the rule the user actually set.
    const groupId = await this.groups.resolveAutoGroupId(cwd);
    // BEFORE the run row exists. A CLI that has to bring the conversation
    // across can refuse (it was deleted, it is under another profile), and a
    // refusal must leave no half-made thread behind — the user gets the CLI's
    // own sentence instead of a chat whose first message dies on a session
    // nobody can find.
    if (input.resumeSessionId !== undefined) {
      await this.cliSessions.prepare(
        input.agentKind,
        input.resumeSessionId,
        cwd,
        configDir,
      );
    }
    const em = this.em.fork();
    const run = await this.runDao.create(
      {
        workflowId: null,
        status: 'pending',
        agentKind: input.agentKind,
        cwd,
        model: input.model ?? null,
        effort: input.effort ?? null,
        configDir,
        // Blank normalizes to null so "typed nothing" and "cleared the box"
        // are one state in the row, and the turn input below cannot hand an
        // adapter an empty string to compose around.
        customInstructions: input.customInstructions?.trim() || null,
        groupId,
        title: input.title ?? null,
        // New chats always carry an explicit mode; only pre-selector rows
        // stay null.
        approval: this.initialApproval(input.agentKind, input.approval),
      },
      em,
    );
    if (input.resumeSessionId !== undefined) {
      await this.adoptSession(em, run.id, input, cwd, configDir);
    }
    return this.toRunWire(run);
  }

  /**
   * Bind a fresh run to a conversation the CLI already holds, and fill the
   * thread with what was said in it.
   *
   * The session id goes on `node_state` — the same row a live turn writes and
   * reads — so nothing about resuming has to know that this thread began as an
   * import: the next turn finds a session id where it always looks and passes
   * it as `resumeSessionId`.
   *
   * The notice is written FIRST, at the transcript's head, and its wording is
   * the service's. Everything after it is the imported conversation, written
   * through the same `mapEventToItem` a live turn's events pass through — so an
   * imported message and a message this app watched arrive are the same row,
   * which is the whole point of doing it this way rather than with a second
   * row builder.
   *
   * Awaited rather than backgrounded: the POST is what the picker is waiting
   * on, and a thread that opens empty and fills in a few seconds later is
   * indistinguishable from one that failed. It also keeps the ordering safe —
   * the user cannot send a message into a transcript that is still being
   * written.
   */
  private async adoptSession(
    em: EntityManager,
    runId: string,
    input: { agentKind: AgentKind; resumeSessionId?: string },
    cwd: string,
    configDir: string | null,
  ): Promise<void> {
    const sessionId = input.resumeSessionId;
    if (sessionId === undefined) {
      return;
    }
    await this.nodeStateDao.saveSessionId(
      runId,
      SINGLE_AGENT_NODE,
      sessionId,
      em,
    );
    const { events, notice } = await this.cliSessions.importHistory(
      input.agentKind,
      sessionId,
      cwd,
      configDir,
    );
    if (notice !== null) {
      await this.persist(
        em,
        runId,
        await this.seqs.reserve(runId),
        'system',
        null,
        // `severity: 'info'`, which is what keeps this out of the failure
        // chrome every other daemon-written notice earns. The rows this path
        // writes are the import REPORTING ITSELF — history left out, a record
        // that could not be read — not something going wrong, and dressing a
        // successful import in red is the exact complaint `isInfoNotice` was
        // added for.
        { message: notice, severity: 'info' },
      );
    }
    for (const event of events) {
      const item = mapEventToItem(event);
      if (item === null) {
        continue;
      }
      await this.persist(
        em,
        runId,
        await this.seqs.reserve(runId),
        item.kind,
        item.role,
        item.payload,
      );
    }
  }

  /**
   * PATCH /v1/chats/:runId/settings — change what the NEXT turn runs as: the
   * approval mode, the model, the reasoning effort, or any combination. 400
   * for a non-auto mode on a cursor chat or an effort level the run's CLI does
   * not accept.
   *
   * `model` and `effort` are accepted WHILE A TURN IS RUNNING, deliberately.
   * This route has only ever described the next turn: a running turn's argv was
   * fixed when it spawned and no adapter can mutate it in flight, so a 409
   * refused a write whose meaning was unchanged either way — it only made the
   * user wait to express a choice that was going to apply later regardless.
   *
   * `approval` is the EXCEPTION, and 409s exactly as it used to. It is the
   * app's only permission control: `auto` is what makes the daemon
   * auto-approve every tool request. Accepting the write unconditionally meant
   * a user could flip `auto → ask`, get a 200 and a chip reading `ask`, then
   * send — and the turn that claimed the run in the window before the write
   * committed would run fully auto-approved under a UI that said otherwise.
   * For the two cosmetic fields an ACK that the NEXT turn honours is the whole
   * promise; for this one, ACK has to mean applied.
   *
   * `model: null` / `effort: null` are real values — they clear the run back
   * to the CLI's own default (no `--model` / `--effort` flag), which an
   * omitted key cannot express.
   */
  async updateSettings(
    runId: string,
    patch: {
      approval?: ChatApprovalMode;
      model?: string | null;
      effort?: string | null;
    },
  ): Promise<RunWire> {
    const em = this.em.fork();
    const run = assertChatRun(await this.runDao.getById(runId, em), runId);
    if (patch.approval !== undefined) {
      this.assertApprovalSupported(run.agentKind, patch.approval);
    }
    if (patch.effort !== undefined) {
      // The model this patch LEAVES the run on — its own if it is changing one,
      // otherwise the run's. Checking against the old model would refuse a level
      // that only the incoming one offers.
      this.assertEffortSupported(
        run.agentKind,
        patch.effort,
        patch.model !== undefined ? patch.model : run.model,
      );
    }
    const changes = {
      ...(patch.approval !== undefined ? { approval: patch.approval } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    };
    // Captured before the write: `updateById` mutates this same
    // identity-mapped entity, so `run.approval` is already the NEW value by the
    // time it returns — the revert below needs the old one.
    const previousApproval = run.approval;
    // A turn in flight no longer refuses the change — it is HANDED it. The CLI
    // accepts a `set_permission_mode` on a turn already running and re-reads it
    // within milliseconds (probe-verified on claude 2.1.222), which is what the
    // CLI itself does when the user switches mode mid-turn, so refusing here
    // was a limitation of this service rather than of the agent.
    //
    // Only the case that is still genuinely unhonourable refuses: a turn with
    // no permission dialogue to be told through. `applyLive` reports that as
    // false, and it is a fact about how the turn SPAWNED — under
    // `--dangerously-skip-permissions` there is no prompt tool, so no message
    // can reintroduce a gate the process was started without, and ACKing one
    // would state a safety posture the user does not have.
    let deliveredLive = false;
    if (patch.approval !== undefined && this.registry.has(runId)) {
      const applyLive = this.liveApproval.get(runId);
      deliveredLive = applyLive?.(patch.approval) === true;
      if (!deliveredLive) {
        throw new ConflictException(
          'RUN_BUSY',
          'this turn is running without a permission gate, so its approval mode cannot be changed until it settles',
        );
      }
    }
    if (patch.approval !== undefined) {
      // Also when NO turn is in flight, which is the whole point: the run's
      // process is still alive and can ask permission before the next turn
      // opens, and this is the only record of what to answer it with.
      this.runPosture.set(runId, patch.approval);
    }
    await this.runDao.updateById(runId, changes, em);
    // A turn may have claimed the run DURING the write — after the check above
    // but before the flush — and `sendMessage` snapshots the row in its own
    // fork, so that turn may already be spawning under the OLD mode. ACKing
    // here would tell the user a permission mode the in-flight turn will not
    // honour, so the approval half is reverted and refused. The model/effort
    // half of the same PATCH is left applied: it only ever described the next
    // turn, so nothing about it is untrue.
    //
    // Skipped once the change was delivered LIVE: the turn that made
    // `registry.has` true is the very one that just took the new mode, so
    // reverting here would undo a change already in effect and refuse a
    // request that succeeded.
    if (
      patch.approval !== undefined &&
      !deliveredLive &&
      this.registry.has(runId)
    ) {
      await this.runDao.updateById(runId, { approval: previousApproval }, em);
      throw new ConflictException(
        'RUN_BUSY',
        'a turn started while the approval change was in flight — retry once it settles',
      );
    }
    Object.assign(run, changes);
    const previews = await this.itemDao.latestMessageTextPerRun([runId], em);
    return this.toRunWire(run, previews.get(runId) ?? null);
  }

  /**
   * The claude permission-mode verdict, degrading a probe INFRASTRUCTURE
   * failure to `unknown` instead of failing the turn — mirrors the graph
   * executor's degrade-catch (an unknown verdict keeps the requested mode).
   */
  private async claudeModesSafe(): Promise<ClaudeModesCapability> {
    try {
      return await this.claudeProbe.ensureVerdict();
    } catch {
      return this.claudeProbe.capability();
    }
  }

  /**
   * Refuse an approval mode the run's CLI does not honour.
   *
   * Asked of the adapter (`config.approval.modes`) rather than branched on the agent
   * kind, for the same reason as {@link assertEffortSupported}: which modes
   * exist is that CLI's fact. Refusing here — where the choice is made — is
   * deliberate and differs from a workflow node's visible degrade: a chat's
   * mode is picked interactively, so the honest answer is "no" rather than a
   * control that silently means something else.
   */
  private assertApprovalSupported(
    agentKind: AgentKind | null,
    approval: ChatApprovalMode | undefined,
  ): void {
    if (approval === undefined || agentKind === null) {
      return;
    }
    const adapter = this.adapterFor(agentKind);
    if (!adapter.getConfig().approval.modes.includes(approval)) {
      throw new BadRequestException(
        'APPROVAL_MODE_UNSUPPORTED',
        `${agentKind} does not support the approval mode '${approval}'`,
      );
    }
  }

  /**
   * The mode a NEW chat starts in: what the user picked, else the app's
   * preferred default — narrowed to what that CLI actually honours.
   *
   * `auto` is the floor rather than a per-CLI default anyone has to declare:
   * running unattended is the one thing no CLI here can refuse, so a CLI
   * without a permission channel lands there by construction instead of by an
   * `if` naming it.
   */
  private initialApproval(
    kind: AgentKind,
    picked: ChatApprovalMode | undefined,
  ): ChatApprovalMode {
    if (picked !== undefined) {
      return picked;
    }
    const modes = this.adapterFor(kind).getConfig().approval.modes;
    return modes.includes(CHAT_DEFAULT_APPROVAL)
      ? CHAT_DEFAULT_APPROVAL
      : 'auto';
  }

  /** The adapter driving one agent kind — the single kind→adapter dispatch. */
  private adapterFor(kind: AgentKind): AgentAdapter {
    return this.adapters.for(kind);
  }

  /**
   * Refuse an effort level the run's CLI does not accept.
   *
   * Asked of the adapter rather than branched on the agent kind: the levels
   * are that CLI's vocabulary, and a CLI with none lists nothing — so the same
   * check both rejects `xhigh` on cursor (no effort control at all) and
   * `ultrathink` on claude (a value it warns about and ignores). Without it
   * the flag would reach the child and the turn would silently run at a
   * different effort than the one acknowledged.
   */
  private assertEffortSupported(
    agentKind: AgentKind | null,
    effort: string | null,
    /**
     * The model this run will actually use, when one is named. It is what makes
     * the refusal exact for a CLI whose levels belong to the model rather than
     * to the binary — see {@link EffortsService.accepts}, which consults only a
     * listing already held so this stays off the request's critical path.
     */
    model: string | null = null,
  ): void {
    if (effort === null || agentKind === null) {
      return;
    }
    if (!this.efforts.accepts(agentKind, effort, model)) {
      throw new BadRequestException(
        'EFFORT_UNSUPPORTED',
        `${agentKind} does not accept the reasoning effort '${effort}'`,
      );
    }
  }

  /**
   * The canonical form of a chat's chosen config directory, or null when none
   * was chosen.
   *
   * REFUSES a CLI that has no such mechanism, rather than stripping the
   * field the way the graph executor does for a workflow node. The two differ
   * because the choice does: a workflow can be imported from YAML naming a
   * config directory on a CLI the builder never offered the field for, so
   * dropping it with a visible notice is the only way to run the graph at all;
   * a chat's directory is picked interactively one control away from the agent
   * picker, so the honest answer is "no" — the same reasoning as
   * {@link assertApprovalSupported}.
   *
   * The adapter owns the verdict (`AdapterConfig.configDir.unavailableReason`),
   * so no agent is named here.
   */
  private resolveConfigDir(
    agentKind: AgentKind,
    configDir: string | undefined,
  ): string | null {
    if (configDir === undefined) {
      return null;
    }
    const reason =
      this.adapterFor(agentKind).getConfig().configDir.unavailableReason;
    if (reason !== null) {
      throw new BadRequestException('CONFIG_DIR_UNSUPPORTED', reason);
    }
    return resolveValidConfigDir(configDir);
  }

  /**
   * Forget the custom instructions every existing run snapshotted.
   *
   * The escape hatch the snapshot design otherwise lacks: a user who pasted
   * something they regret into the global box can clear it, but every chat
   * opened beforehand still carries the old text and would send it again on
   * its next turn. Nothing else purges that short of deleting the chat.
   *
   * Deliberately NOT wired to clearing the settings box — it discards a real
   * guarantee (a chat keeps what it started with), so it is an explicit action
   * with its own control, not a side effect of an edit the user might be
   * halfway through.
   */
  async forgetCustomInstructions(): Promise<{ cleared: number }> {
    const em = this.em.fork();
    const cleared = await this.runDao.forgetCustomInstructions(em);
    return { cleared };
  }

  async listChats(): Promise<RunWire[]> {
    const em = this.em.fork();
    const runs = await this.runDao.listChats(em);
    const previews = await this.itemDao.latestMessageTextPerRun(
      runs.map((run) => run.id),
      em,
    );
    return runs.map((run) => this.toRunWire(run, previews.get(run.id) ?? null));
  }

  /**
   * Run-level rename shared by BOTH run kinds — the sidebar lists chat and
   * workflow runs together, so this route deliberately skips the chat-kind
   * guard the message/cancel routes apply: `title` is a run-row property,
   * not an execution command that must reach the right engine.
   */
  async rename(runId: string, title: string): Promise<RunWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    await this.runDao.updateById(runId, { title }, em);
    run.title = title;
    const previews = await this.itemDao.latestMessageTextPerRun([runId], em);
    return this.toRunWire(run, previews.get(runId) ?? null);
  }

  /**
   * File a run into a sidebar group, or (null) out of every group.
   *
   * Kind-blind for the same reason `rename` is: the sidebar lists chat and
   * workflow runs together and a group holds either, so this is a run-row
   * property rather than an execution command that has to reach the right
   * engine.
   *
   * The group is checked BEFORE the write. A dangling id would degrade
   * quietly — the sidebar files an unmatched run into the loose list, which
   * looks exactly like "nothing happened" — so the honest answer to a group
   * that does not exist is a 404, not a run that silently stayed put.
   */
  async setGroup(runId: string, groupId: string | null): Promise<RunWire> {
    if (groupId !== null) {
      await this.groups.assertExists(groupId);
    }
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    await this.runDao.updateById(runId, { groupId }, em);
    run.groupId = groupId;
    const previews = await this.itemDao.latestMessageTextPerRun([runId], em);
    return this.toRunWire(run, previews.get(runId) ?? null);
  }

  async getHistory(runId: string, afterSeq = -1): Promise<ItemWire[]> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    const items = await this.itemDao.getByRun(runId, afterSeq, em);
    return items.map((item) => this.itemToWire(item));
  }

  async cancel(runId: string): Promise<{ cancelled: boolean }> {
    const em = this.em.fork();
    // Kind-guarded like sendMessage: this cancel and the graph executor's
    // converge on the same registry key, so a wrong-endpoint call must 400
    // instead of silently cancelling the other kind's run.
    const run = assertChatRun(await this.runDao.getById(runId, em), runId);
    const cancelled = this.registry.cancel(runId);
    if (cancelled) {
      // A live turn owns the run: its finalizer writes the terminal status
      // when the handle settles, and writing one here would race it.
      return { cancelled };
    }
    // NOTHING was in flight. Before, this returned false and wrote nothing —
    // so a run whose row still said `running` (a daemon killed mid-turn, a
    // handle that vanished) stayed "running" forever with no turn left to
    // settle it, and its badge lied in every list that showed it. Cancel is
    // the user saying "this is over": make the row say so.
    if (!isTerminalRunStatus(run.status)) {
      await this.persist(
        em,
        runId,
        await this.seqs.reserve(runId),
        'turn_cancelled',
        null,
        { reason: 'cancelled with no turn in flight' },
      );
      await this.setRunStatus(em, runId, 'cancelled');
      this.logger.warn(
        `cancel found no live turn for run ${runId} — reconciled its status from '${run.status}' to cancelled`,
      );
    }
    return { cancelled };
  }

  /**
   * Delete a chat and everything it owns — a ONE-WAY DOOR. The teardown itself
   * is {@link RunTeardownService}, shared with the workflow-run delete so the
   * two cannot drift; what this method owns is the chat-specific part: the
   * run-kind guard, the claim→register window, and WHICH promise counts as
   * "the run has stopped writing" (this turn's finalizer, not its handle).
   */
  async delete(runId: string): Promise<{ deleted: boolean }> {
    const em = this.em.fork();
    // Kind-guarded like cancel and sendMessage: a workflow run deleted through
    // the chat route would skip the graph executor's own teardown.
    assertChatRun(await this.runDao.getById(runId, em), runId);

    // Claimed BEFORE the cancel, so a turn still crossing the claim→register
    // window (where it has no finalizer to wait on) sees the delete and aborts
    // rather than registering behind our back.
    this.deleting.add(runId);
    try {
      return await this.teardown.purge(em, runId, this.finalizing.get(runId));
    } finally {
      this.deleting.delete(runId);
      // The run is gone, so its posture has nothing left to govern — and the
      // teardown has already closed the process that would have consulted it.
      this.runPosture.delete(runId);
    }
  }

  /**
   * Everything the CLI produces with no turn of ours in flight.
   *
   * **This is a whole conversation, not a stray line.** After a turn's `result`
   * the CLI can start a further turn of its own accord — a delegate reporting
   * back is the measured cause, and its result line names itself
   * `origin:{kind:"task-notification"}`. `spawn-cli` has no turn to hand that
   * output to, so it arrives here.
   *
   * It used to be filtered down to the two halves of a tool call, on the
   * argument that those carry an id that pairs them while a stray message has
   * no anchor. The pairing half of that is right and is kept; the conclusion
   * was not. Measured on a live delegating chat (2026-08-14, claude 2.1.232):
   * seven seconds after the turn settled the CLI ran a whole further turn, and
   * this method dropped 2 `text` events, 5 `text_delta`, 2 `turn_complete`, a
   * `session`, and every progress and harvest event with them — keeping only
   * the tool call and its result. What the user saw is exactly what was
   * reported: a run badged `completed` with more work appearing under it, and
   * the agent's own messages after that point simply not arriving. Dropping an
   * event because geniro has no turn to file it under is geniro's bookkeeping
   * problem being charged to the user's transcript.
   *
   * So the rule is now the same one the in-turn path uses — whatever
   * `mapEventToItem` yields a row for is persisted, in arrival order, under
   * this run — plus the three things that are not rows: the live signals feed
   * the same partial stream, the self-reports feed the same harvest stores, and
   * a terminal event settles the run again.
   *
   * **The one thing that does NOT follow the in-turn path is the run status
   * after a Stop.** A cancelled run's trailing output is still recorded (the
   * work happened, and hiding it is how a transcript starts lying), but it must
   * not move the badge: the user asked this to stop, and a straggling `result`
   * flipping `cancelled` back to `completed` is the defect that first put a
   * filter here.
   *
   * Run-scoped by construction — its own `em` fork and the run's seq
   * allocator, nothing borrowed from a turn that has already settled. Failure
   * is logged and swallowed: this is called from the session's event path,
   * where a throw has no caller to reach.
   */
  /**
   * Put a request that arrived with NO turn in flight in front of the user, as
   * the same card an in-turn one gets.
   *
   * The path this replaces is what a whole run was lost to. claude's process
   * outlives its turn and goes on working (`handleBetweenTurnEvent`), and eight
   * minutes after a turn had settled it asked an `AskUserQuestion`. With no turn
   * to raise a card, the session HELD it for a later turn to adopt — so the
   * transcript grew the tool-call row, the badge went on saying the agent was
   * working, and nothing anywhere offered a way to answer. Twenty-two minutes
   * later the idle window closed the process, the CLI read the close as a
   * refusal, and the user was shown a bare `claude run failed` for a question
   * they had never seen. Both halves are fixed: this raises the card, and the
   * session reports itself `parked` so the reaper leaves it alone.
   *
   * SYNCHRONOUS by contract — the session needs an immediate yes/no about who
   * owns the request — so the writes ride a floating promise. The claim is
   * therefore optimistic, and the one way it can be wrong is handled the way
   * the in-turn branch handles it: if the card cannot be persisted the user will
   * never see it, so the CLI is refused rather than left blocked forever.
   */
  private raiseHeldApproval(
    runId: string,
    adapter: AgentAdapter,
    event: Extract<AgentEvent, { type: 'approval_request' }>,
    respond: (allow: boolean, input?: unknown) => boolean,
  ): boolean {
    const mapped = mapEventToItem(event);
    if (!mapped) {
      return false;
    }
    const isQuestion = isUserQuestion(
      adapter.getConfig().questionToolName,
      event.toolName,
    );
    void (async () => {
      const em = this.em.fork();
      try {
        await this.persist(
          em,
          runId,
          await this.seqs.reserve(runId),
          mapped.kind,
          mapped.role,
          mapped.payload,
        );
      } catch (err) {
        respond(false);
        this.logger.error(
          `run ${runId} could not persist a between-turn card for '${event.toolName}' — refused it instead: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      this.approvals.track({
        runId,
        nodeId: SINGLE_AGENT_NODE,
        requestId: event.id,
        toolName: event.toolName,
        input: event.input,
        question: isQuestion,
        respond: (allow, answer) => {
          const delivered = respond(
            allow,
            foldApprovalAnswer(
              adapter,
              event.toolName,
              event.input,
              allow,
              answer,
            ),
          );
          this.announceAwaiting(runId);
          if (delivered) {
            void (async () => {
              await this.persist(
                em,
                runId,
                await this.seqs.reserve(runId),
                'approval_verdict',
                null,
                {
                  id: event.id,
                  allow,
                  // Recorded only when it was actually folded, on the same rule
                  // the in-turn branch states: the transcript must never claim
                  // an answer the agent did not receive.
                  ...(answerFoldsInto(
                    adapter.getConfig().questionToolName,
                    event.toolName,
                    allow,
                    answer,
                  )
                    ? { answer }
                    : {}),
                },
              );
            })().catch((err: unknown) => {
              this.logger.error(
                `run ${runId} between-turn verdict item write failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
          }
          return delivered;
        },
      });
      // After the track, so the registry this reads already holds the card —
      // exactly as the in-turn branch orders it. Without this the badge keeps
      // announcing whatever the CLI was last doing, which is the half of the
      // report that read as "it says it is working while it waits for me".
      this.announceAwaiting(runId);
    })();
    return true;
  }

  private async handleBetweenTurnEvent(
    runId: string,
    agent: AgentKind,
    cwd: string,
    event: AgentEvent,
  ): Promise<void> {
    // Live-only signals: no row, no seq, no replay — the same treatment the
    // in-turn handler gives them. Without these the transcript grows rows with
    // no live row above them, which is the "it says completed while it works"
    // half of the report seen from the other side.
    if (event.type === 'text_delta') {
      if (event.parentToolUseId === undefined) {
        this.partials.append(runId, SINGLE_AGENT_NODE, null, event.text);
        await this.restatusAfterOffTurnSignal(runId, event);
      }
      return;
    }
    if (event.type === 'thinking_progress') {
      if (event.parentToolUseId === undefined) {
        this.partials.thinking(runId, SINGLE_AGENT_NODE, null, event.tokens);
        await this.restatusAfterOffTurnSignal(runId, event);
      }
      return;
    }
    if (event.type === 'context_progress') {
      this.partials.context(
        runId,
        SINGLE_AGENT_NODE,
        null,
        event.contextTokens,
      );
      return;
    }
    // What the CLI reports about ITSELF is true whether or not a turn of ours
    // is open, and each of these feeds a panel rather than the transcript.
    if (event.type === 'slash_commands') {
      this.skillHarvest.record(agent, cwd, event.commands);
      return;
    }
    if (event.type === 'mcp_servers') {
      this.mcpHarvest.record(agent, cwd, null, event.servers);
      return;
    }
    if (event.type === 'session') {
      // The continuation runs in the same conversation, so this is the id a
      // later resume has to reach. Dropping it left the run resuming a session
      // that no longer had the last of its history. Written straight through
      // rather than through the turn's changed-only saver, which belongs to a
      // turn that no longer exists — the id repeats at most once per off-turn
      // continuation, so the dedupe it provides is not worth the coupling.
      await this.nodeStateDao.saveSessionId(
        runId,
        SINGLE_AGENT_NODE,
        event.sessionId,
        this.em.fork(),
      );
      return;
    }
    const mapped = mapEventToItem(event);
    if (!mapped) {
      // No row and no live meaning — `background_work` bookkeeping for a turn
      // that no longer exists is the standing example.
      return;
    }
    try {
      const em = this.em.fork();
      await this.persist(
        em,
        runId,
        await this.seqs.reserve(runId),
        mapped.kind,
        mapped.role,
        mapped.payload,
      );
      // Main thread only, exactly as in the in-turn path above: the tail holds
      // the main agent's words, so a delegate's durable message must not take
      // them away.
      if (mapped.kind === 'message' && event.parentToolUseId === undefined) {
        this.partials.retire(runId, SINGLE_AGENT_NODE, null);
      }
      // The ROW is written whatever produced it — a transcript that hides work
      // is the other way of lying. What the RUN is doing is a different
      // question, and a DELEGATE's row does not answer it.
      //
      // A delegate is the background work the turn was already held for, and
      // its trailing rows land as it finishes. Restating them as the run
      // working again put a `still working` spinner on screen at the exact
      // moment the work ENDED — and nothing could ever take it down, because
      // only a terminal event settles this state and a delegate winding up
      // opens no turn of its own to produce one. Reproduced: the delegate's
      // block reads `done`, the turn reads `✓ done`, and the row under them
      // counts upward for as long as the chat is open. That is the reported
      // "агент вроде как закончил работать, а он статуса не изменил — он всё
      // ещё пишет still working".
      //
      // A delegate still working is not lost by this: the renderer derives it
      // from the transcript (`subagentRunning`), which closes by itself when
      // the delegate's block returns. The CLI genuinely carrying on — a
      // task-notification continuation — writes MAIN-THREAD rows and still
      // flips the run back to `running`, and its own result settles it again.
      //
      // The delegate LIFECYCLE announcement is main-thread and so passes that
      // test, and its two directions mean opposite things. A delegate STARTING
      // is the run working — that is the whole point of routing it here, since
      // a delegate launched between turns is otherwise invisible and the run
      // reads `completed` under agents that are demonstrably still going. A
      // delegate FINISHING is the same "restated the end of work as the start
      // of some" the paragraph above is about, and would latch the spinner on
      // with nothing left to take it down.
      //
      // A delegate's OWN row takes the third path, {@link leaseOnDelegateRow}:
      // it makes the same "something is being produced" claim, under an expiry
      // rather than under a terminal event it will never get. Refusing it
      // outright — which is what this branch used to do — is what left a run
      // reading `completed` while its sub-agent blocks went on filling up.
      this.recordDelegateBracket(runId, event);
      if (event.parentToolUseId !== undefined) {
        await this.leaseOnDelegateRow(runId, event.parentToolUseId);
      } else if (!closesADelegate(event)) {
        await this.restatusAfterOffTurnEvent(em, runId, event);
      }
    } catch (err: unknown) {
      this.logger.error(
        `run ${runId} failed to persist a between-turn ${event.type}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * What an off-turn row does to the run's badge.
   *
   * A settled run that is producing rows again is working again, so it goes
   * back to `running`; the continuation's own result settles it. Two runs are
   * left alone entirely:
   *
   * - one the user CANCELLED. Stop is final — a straggling result flipping
   *   `cancelled` back to `completed` tells them their Stop did not take.
   * - one whose status this method did not write. `spawn-cli` only routes here
   *   while no turn is open, but this handler is async, so a new turn can have
   *   opened in between — and settling THAT turn's run on the previous one's
   *   trailing result is the exact defect `cancelledTurnMayStillEmit` was
   *   written to stop. {@link offTurnRuns} is how it knows the difference: it
   *   holds the runs whose `running` is its own.
   */
  private async restatusAfterOffTurnEvent(
    em: EntityManager,
    runId: string,
    event: AgentEvent,
  ): Promise<void> {
    const run = await this.runDao.getById(runId);
    if (!run || run.status === 'cancelled') {
      return;
    }
    const settled = terminalStatus(event);
    if (settled) {
      // The continuation has finished, so nothing is owed to a delegate whose
      // rows opened this stretch — its lease has just been answered by the very
      // terminal event it existed for want of.
      this.clearDelegateLease(runId);
      if (this.offTurnRuns.delete(runId)) {
        await this.setRunStatus(em, runId, settled);
      }
      return;
    }
    if (run.status === 'running') {
      // Either a real turn owns it, or this method already moved it — the
      // phrase is worth repeating either way, the write is not.
      this.announceActivity(runId, offTurnActivity(event));
      return;
    }
    this.offTurnRuns.add(runId);
    await this.setRunStatus(em, runId, 'running', {
      activity: offTurnActivity(event),
    });
  }

  /**
   * What a LIVE off-turn signal does to the run's badge.
   *
   * Rows are only half of what a continuation produces. An agent that is
   * THINKING has emitted no row at all — and on a long think it will not for
   * minutes — and neither has one part-way through a sentence. Both signals
   * were routed to the live tail and nowhere else, so the transcript grew a
   * `Thinking… 500 tokens · 6s` line directly under a `✓ done` footer while the
   * sidebar row still read `completed`. That is the reported "it show as
   * completed, but its actually thinking", and the claim it needs is the one
   * {@link restatusAfterOffTurnEvent} already makes about rows: something is
   * being produced under a run that had settled, so the run is working again.
   *
   * Deliberately a separate method rather than another caller of that one, for
   * two reasons a shared body could not hold:
   *
   * - A delta fires many times a second. Once the flip has happened the phrase
   *   never changes, so {@link offTurnRuns} short-circuits the rest of the
   *   burst before it reaches the database.
   * - A run whose `running` belongs to a REAL turn is left entirely alone here,
   *   instead of having that turn's activity phrase restated as `still
   *   working`. A row is worth re-announcing for; an unfinished word is not.
   *
   * `context_progress` is the third live signal and is deliberately NOT one of
   * these: it measures the WINDOW rather than asserting that anything is being
   * produced, and it is also emitted synthetically once a compaction has
   * FINISHED — the one moment the CLI is demonstrably not working.
   */
  private async restatusAfterOffTurnSignal(
    runId: string,
    event: AgentEvent,
  ): Promise<void> {
    if (this.offTurnRuns.has(runId) || this.offTurnSignalClaims.has(runId)) {
      return;
    }
    this.offTurnSignalClaims.add(runId);
    try {
      const run = await this.runDao.getById(runId);
      // A cancelled run stays cancelled — Stop is final, exactly as it is for an
      // off-turn row — and a `running` one is somebody else's to describe.
      if (!run || run.status === 'cancelled' || run.status === 'running') {
        return;
      }
      this.offTurnRuns.add(runId);
      await this.setRunStatus(this.em.fork(), runId, 'running', {
        activity: offTurnActivity(event),
      });
    } finally {
      this.offTurnSignalClaims.delete(runId);
    }
  }

  /**
   * What a DELEGATE's off-turn row does to the run's badge.
   *
   * A delegate whose launching `Task` call has already returned goes on working
   * with nothing holding the turn open for it: `spawn-cli` only holds on
   * `background_work`, which is the CLI's own `task_started` bracket, and a
   * delegate it never brackets is invisible to that mechanism. The turn's
   * `result` therefore settles the run while the delegate's steps keep arriving
   * — reproduced against the real renderer: two sub-agent blocks climbing from
   * 0 to 7 tool calls, their rows persisted the whole time, under a header
   * reading `✓ completed`. That is the reported "выполняются какие-то
   * внутренние процессы, но он показывается как Completed".
   *
   * So a delegate's row makes the same claim a main-thread one does — something
   * is being produced under a run that had settled — and the two directions
   * that used to be refused here are both kept:
   *
   * - It is still not {@link restatusAfterOffTurnEvent}. That method's `running`
   *   is ENDED by a terminal event, and a delegate produces none; restating a
   *   delegate's trailing rows through it is what latched a `still working`
   *   spinner on at the exact moment the work ended, with nothing able to take
   *   it down. The lease is that missing off-switch.
   * - A delegate CLOSING (`closesADelegate`) still restates nothing, and now
   *   need not be special-cased: a close carries no `parentToolUseId`, so it
   *   never reaches here at all.
   *
   * Renewal is free — a live delegate emits rows continuously, and re-arming a
   * timer must not cost a write — so only the FIRST row of a quiet stretch
   * touches the database.
   */
  private async leaseOnDelegateRow(
    runId: string,
    delegateId: string,
  ): Promise<void> {
    if (this.closedDelegates.get(runId)?.has(delegateId)) {
      // Its trailing rows, not its work — see {@link closedDelegates}. This is
      // the case the row path refuses outright, and it stays refused.
      return;
    }
    const held = this.delegateLeases.get(runId);
    if (held) {
      held.timer.refresh();
      return;
    }
    if (this.leaseClaims.has(runId)) {
      // A lease for this run is being taken as this row arrives, so the row
      // that started it covers this one too — and there is no timer to renew
      // yet. See {@link leaseClaims}.
      return;
    }
    const claim = Symbol('delegate-lease');
    this.leaseClaims.set(runId, claim);
    try {
      const run = await this.runDao.getById(runId);
      // Same two exemptions as every other off-turn restate: Stop is final, and
      // a `running` run is somebody else's to describe — either a real turn owns
      // it, or the main thread's own continuation already flipped it, and that
      // one settles itself.
      if (!run || run.status === 'cancelled' || run.status === 'running') {
        return;
      }
      if (this.leaseClaims.get(runId) !== claim) {
        // Something took the badge over while the run was being read, and said
        // so by dropping this claim. Installing the lease now would take it
        // back — and the key may already belong to a later acquisition, which
        // is why identity is compared rather than presence.
        return;
      }
      const restoreTo = run.status;
      const timer = setTimeout(() => {
        void this.expireDelegateLease(runId);
      }, DELEGATE_ROW_LEASE_MS);
      timer.unref?.();
      this.delegateLeases.set(runId, { timer, restoreTo });
      this.offTurnRuns.add(runId);
      await this.setRunStatus(this.em.fork(), runId, 'running', {
        activity: 'still working',
      });
    } finally {
      // Only ever our OWN claim: the read can throw (the caller swallows it),
      // and a stranded claim would send every later delegate row home at the
      // guard above — no lease ever taken again, the badge reading `completed`
      // while sub-agents fill, which is the defect the lease exists to remove.
      if (this.leaseClaims.get(runId) === claim) {
        this.leaseClaims.delete(runId);
      }
    }
  }

  /**
   * The delegate has gone quiet for a whole lease, so hand the badge back.
   *
   * Re-reads rather than trusting the lease: a real turn may have started in
   * the meantime (which clears the lease, but the timer may already have been
   * queued), and only a run still wearing the `running` this lease put there is
   * this method's to change back.
   */
  private async expireDelegateLease(runId: string): Promise<void> {
    const held = this.delegateLeases.get(runId);
    if (!held) {
      return;
    }
    this.delegateLeases.delete(runId);
    if (!this.offTurnRuns.delete(runId) || this.registry.has(runId)) {
      return;
    }
    try {
      const run = await this.runDao.getById(runId);
      if (run?.status !== 'running') {
        return;
      }
      // A RESTORE, not an ending: this hands back the status the lease took
      // over. Announced as an ordinary settle it is a second
      // non-terminal→terminal crossing for a turn that ended minutes ago, which
      // the client reads as a fresh ending.
      await this.setRunStatus(this.em.fork(), runId, held.restoreTo, {
        restored: true,
      });
    } catch (err: unknown) {
      this.logger.error(
        `run ${runId} delegate-lease expiry failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Drop a run's delegate lease — whoever takes the badge over owns it now. */
  private clearDelegateLease(runId: string): void {
    const held = this.delegateLeases.get(runId);
    if (held) {
      clearTimeout(held.timer);
      this.delegateLeases.delete(runId);
    }
    // A lease that has not landed yet is taken over too: the claim is dropped
    // here and its holder compares identity after its read.
    this.leaseClaims.delete(runId);
  }

  /**
   * Note that the CLI has told us a delegate started or finished.
   *
   * Called from BOTH event handlers, because which of them a bracket lands in
   * is the CLI's timing rather than a fact about the delegate: a turn held open
   * for its delegates sees every close in-turn, while one that settled first
   * sees them off-turn. Recording only the off-turn half would leave every
   * delegate that finished inside its own turn looking un-bracketed to
   * {@link leaseOnDelegateRow}, so its tail would take a lease.
   *
   * A null `backgroundOpen` says nothing either way — the announcement carrying
   * a delegate's label or duration must not be read as a lifecycle claim.
   */
  private recordDelegateBracket(runId: string, event: AgentEvent): void {
    if (event.type !== 'subagent_info' || event.backgroundOpen === null) {
      return;
    }
    if (event.backgroundOpen) {
      this.closedDelegates.get(runId)?.delete(event.id);
      return;
    }
    const closed = this.closedDelegates.get(runId);
    if (closed) {
      closed.add(event.id);
      return;
    }
    this.closedDelegates.set(runId, new Set([event.id]));
  }

  /**
   * Persist the user message, then start a turn whose streamed events are each
   * persisted-then-emitted. Returns the persisted user item immediately; the
   * agent's reply streams over the bus → WS while this method has already
   * resolved.
   */
  async sendMessage(
    runId: string,
    text: string,
    images: SendMessageImage[] = [],
  ): Promise<ItemWire> {
    const em = this.em.fork();
    const run = assertChatRun(await this.runDao.getById(runId, em), runId);
    if (!run.cwd || !run.agentKind) {
      throw new BadRequestException(
        'RUN_NOT_CONFIGURED',
        'run is missing a working directory or agent',
      );
    }
    // Reserve the run synchronously BEFORE any further await — this closes the
    // check-then-act window where two concurrent messages would both pass the
    // busy check, share one `maxSeq` base, allocate colliding seq values (the
    // renderer then de-dupes by seq and silently drops one), and spawn two CLIs.
    if (!this.registry.tryClaim(runId)) {
      // A turn holds the run. That used to be the end of it — the message went
      // back as RUN_BUSY and sat in the renderer's queue until the CLI process
      // exited, so "send this next" meant "after everything currently running
      // finishes", which can be minutes. The CLI itself does not work that way:
      // its stream-json stdin is a conversation, and a follow-up written into a
      // running turn is picked up at the next tool boundary. So try that first,
      // and fall back to the queue only when this CLI has no such channel (ACP)
      // or the turn is already on its way out.
      return await this.deliverIntoRunningTurn(runId, text, images);
    }
    try {
      const cwd = resolveValidCwd(run.cwd);
      const agentKind = run.agentKind;

      // Re-read the committed settings from a FRESH fork now that the claim is
      // held: a settings PATCH that flushed to its own fork between the getById
      // above and the claim never mutated `run`, so its ACKed values would
      // otherwise be ignored. The claim now 409s any later PATCH, and
      // updateSettings reverts a PATCH that raced the claim, so this read
      // reflects exactly the acknowledged settings. Read as one row, not field
      // by field: `committed.model ?? run.model` would resurrect the old model
      // for a PATCH that deliberately cleared it back to the CLI default.
      const settings =
        (await this.runDao.getById(runId, this.em.fork())) ?? run;
      // A null `approval` is a chat row created before the mode selector
      // existed. It used to ride through as `undefined`, which spawns the CLI
      // with no permission flag at all and inherits whatever that CLI defaults
      // to — safe while claude's default was "ask about everything", and no
      // longer: probed on 2.1.227, a headless turn with no flag now reports
      // `permissionMode: "auto"`, the new default Anthropic is rolling out.
      // So an old chat would have started approving every tool call
      // unattended, on a decision the vendor made and the user never saw.
      //
      // Resolved HERE rather than in the adapter because this is the layer
      // that knows what a null row MEANS. The same undefined reaching an
      // adapter from a geniro-internal probe turn means something else
      // entirely, and pinning it there would put a permission dialogue on
      // turns that exist only to read one `system/init` line.
      //
      // `ask` is the answer because "the user never chose a posture" and "do
      // not act unattended" are the same statement.
      const approvalDefault: ChatApprovalMode = 'ask';
      let approvalMode: ChatApprovalMode = settings.approval ?? approvalDefault;
      this.runPosture.set(runId, approvalMode);
      /**
       * Whether the daemon answers this tool's permission itself, without a
       * card — the stand-in for `--dangerously-skip-permissions`.
       *
       * ONE predicate, read by both seams that need it: the in-turn
       * `approval_request` branch, and the between-turn policy handed to the
       * session. They must never diverge — a request judged one way inside the
       * turn and the other way a second after it settled is precisely the
       * inconsistency this change exists to remove.
       *
       * The POSTURE it reads differs by seam, and deliberately: in-turn takes
       * the turn's own `approvalMode` (which `liveApproval` rewrites on a
       * mid-turn chip change), while between turns there is no turn to have a
       * mode, so it reads the run's. Passing the turn's copy there is what let
       * a chip moved to `ask` after a turn ended go on auto-approving.
       */
      const autoApproves = (
        toolName: string,
        mode: ChatApprovalMode | undefined,
      ): boolean =>
        mode === 'auto' &&
        !isUserQuestion(adapter.getConfig().questionToolName, toolName);
      const model = settings.model ?? undefined;
      const effort = settings.effort ?? undefined;
      // Re-resolved per turn, exactly like `cwd` above: the row holds the
      // canonical path as of creation, and a directory deleted (or a symlink
      // re-pointed) since then would otherwise reach argv, where the CLI
      // SILENTLY ignores it — probe-verified, and the reason
      // `resolveValidConfigDir` exists. Refusing the send is the only thing
      // that can tell the user; running the turn under a directory claude
      // freshly created would fail as "Not logged in" against a profile the
      // user never named.
      const configDir = settings.configDir
        ? resolveValidConfigDir(settings.configDir)
        : undefined;
      // Read off the ROW, not off the app's settings: the value was
      // snapshotted when the chat was created, and re-reading the live setting
      // here is exactly what would respawn this run's CLI process mid-thread
      // (`AgentAdapter.sessionKey` hashes it).
      const customInstructions = settings.customInstructions ?? undefined;

      // Store the bytes BEFORE persisting the item: the payload records only
      // the attachment rows, so an item written first would reference files
      // that a failed write never created.
      const attachments = images.map((image) =>
        this.attachments.save(runId, image.mediaType, image.data),
      );

      // Every write below allocates from the run's ONE allocator rather than
      // from a counter local to this turn. A turn is not the only writer of
      // its run's transcript — a follow-up message handed to it mid-flight
      // (`deliverIntoRunningTurn`) writes a user item on its own request
      // chain — and a local counter cannot see that row, so it reissued the
      // seq the follow-up had just taken. See {@link ItemSeqAllocator}.
      const userWire = await this.persist(
        em,
        runId,
        await this.seqs.reserve(runId),
        'message',
        'user',
        { text, ...(attachments.length > 0 ? { images: attachments } : {}) },
      );

      const adapter: AgentAdapter = this.adapterFor(agentKind);

      // The mode this turn actually runs under is the ADAPTER's answer, and any
      // degrade is persisted so the user sees it — the same seam the graph
      // executor uses for a node, so a fix here cannot miss that path. The
      // probe is awaited only for a mode whose support is empirical, so a turn
      // that never asks for one never pays for it.
      const resolved = adapter.resolveApprovalMode(
        approvalMode,
        // The ADAPTER reads its own slice of the capability bag; this
        // service only assembles the bag from the probes it holds. Reading
        // claude's field here instead would judge any future CLI with a
        // probed mode against claude's installed binary.
        adapter.getConfig().approval.probedModes.includes(approvalMode)
          ? adapter.approvalSupportFrom({
              claudeModes: await this.claudeModesSafe(),
            })
          : { supported: {} },
      );
      if (resolved.degradeReason !== null) {
        await this.persist(
          em,
          runId,
          await this.seqs.reserve(runId),
          'system',
          null,
          { message: resolved.degradeReason },
        );
      }
      approvalMode = resolved.mode;

      const node = await this.nodeStateDao.getByRunNode(
        runId,
        SINGLE_AGENT_NODE,
        em,
      );
      const resumeSessionId = node?.agentSessionId ?? null;
      const saveSessionId = createSessionIdSaver(
        this.nodeStateDao,
        runId,
        SINGLE_AGENT_NODE,
        resumeSessionId,
        em,
      );
      // A real turn takes the run over, so whatever an off-turn continuation
      // was still holding is no longer this method's to settle — including a
      // delegate lease, whose expiry would otherwise fire mid-turn and try to
      // hand a badge back that this turn now owns.
      this.offTurnRuns.delete(runId);
      this.clearDelegateLease(runId);
      // The previous turn's delegates cannot outlive this one's badge, and the
      // set is what would otherwise grow for the life of a long chat.
      this.closedDelegates.delete(runId);
      await this.setRunStatus(em, runId, 'running');

      let chain: Promise<void> = Promise.resolve();
      let sawTerminal = false;
      /**
       * The last thing the agent SAID this turn — what a settle announcement
       * carries so a client can tell the user what happened rather than merely
       * that something did.
       *
       * Held here rather than read back from the database at the settle: the
       * text is passing through this very handler, and a run's newest `message`
       * row is not reliably the agent's (a queued follow-up drains into the
       * transcript as a user message the moment the turn ends).
       */
      let lastAgentText: string | null = null;
      /**
       * What this turn has PRODUCED, split into the CLI's own compaction and
       * everything else — the two counters behind `RunStatusEvent.housekeeping`.
       *
       * Structural, never a match on the text `/compact`: that string is a
       * thing a user may type as prose, and an AUTOMATIC compaction lands in
       * the middle of a turn doing real work, which must still announce itself.
       * Anything besides the compaction summary — an assistant message, a tool
       * call, a notice of its own — is work and takes the exemption away.
       *
       * TWIN PARSER: `apps/ui/src/renderer/chats/compaction-payload.ts`'s
       * `compactionOnlyTurnEnds` decides the same thing from the persisted
       * items, to drop the redundant `✓ done` row under a compaction. The two
       * readings must agree — a turn the transcript treats as pure
       * housekeeping and the sidebar marks unseen is the app contradicting
       * itself about one turn.
       */
      let compactionRows = 0;
      let workRows = 0;
      let eventHandlingFailed = false;
      /**
       * The token figures the CLI reported for a compaction that just finished,
       * held until its summary arrives so the summary's own row can carry them.
       *
       * The two are separate lines on the stream and neither can see the other:
       * the boundary has the numbers and no text, the injected summary has the
       * text and no numbers. Correlating them is what lets the transcript collapse
       * the summary behind ONE line that says what the compaction actually did
       * ("Conversation compacted · 200.2k → 34.1k") instead of a wall of relayed
       * prose with no heading.
       *
       * Ordering is MEASURED, not assumed — 2.1.228, this daemon's own debug log:
       * the boundary landed at 10:36:13.025 and the summary at 10:36:13.026, one
       * millisecond apart and in that order. A turn-scoped `let` rather than a
       * service field because a compaction belongs to the turn that asked for it,
       * and a stale figure must not be able to reach a later turn's summary.
       *
       * Null is the honest degrade at every point: an auto-compaction whose
       * boundary carries no metadata, a summary that arrives without one, or the
       * graph executor's own event loop (which does not correlate them) all leave
       * the row rendering as the plain relayed note it was before.
       */
      let compactedTokens: {
        preTokens: number | null;
        postTokens: number | null;
      } | null = null;
      /**
       * How many units of background work this turn is being HELD for — 0
       * whenever the agent is itself still working.
       *
       * Per TURN, in this closure, like `compactedTokens` above: one turn's
       * hold says nothing about the next.
       *
       * Fed by `turn_held`, which `runCliSession` raises, and NOT by counting
       * `background_work` here. That was the first attempt and it was dead code
       * on the real path: `spawn-cli` consumes those events as turn plumbing
       * and never forwards them, so the tally never moved outside a spec that
       * called this handler directly. It was also the wrong question — a
       * delegate can be running while its parent edits files, and what both
       * consumers need to know is whether the AGENT has stopped.
       *
       * It exists so the run can SAY what it is waiting for. A turn is held
       * open while units are outstanding (`spawn-cli`'s `TurnState.openWork`),
       * which is deliberate — a delegate that reports after the result line
       * would otherwise have its whole output dropped — but the holding was
       * invisible: the row went on showing the last tool name, so a finished
       * answer sat under "running Read" with a climbing timer and no way to
       * tell a live delegate from a dead one. That was the reported "он
       * закончил, но пишет что он ещё в процессе".
       */
      let heldOnBackgroundWork = 0;
      /**
       * The MAIN thread's tool calls that have started and not yet returned,
       * `id → name`, newest last (a `Map` keeps insertion order).
       *
       * A running tool is the most specific thing the run can be said to be
       * doing, so it wins over the background tally: without this a delegate
       * settling mid-`Bash` would rename the row to "waiting on 2 background
       * tasks" while the parent was demonstrably running Bash.
       *
       * A SET of ids rather than the boolean this started as, because a model
       * routinely issues several tool calls in ONE assistant message and their
       * results come back independently. A boolean is taken down by whichever
       * finishes first, so a batch of `Read`+`Edit` stopped naming the Edit the
       * moment the Read returned — the same "the line does not match the work"
       * complaint as the stale phrase, arriving from the other side. Keeping
       * the names is what lets the announce fall back to a tool that IS still
       * running instead of to silence.
       */
      const openMainTools = new Map<string, string>();
      /**
       * What to say while the main thread still has tools out: the most
       * recently STARTED one that has not returned.
       *
       * Newest rather than oldest because it is the call the model made last
       * and therefore the one the transcript has just shown the user — an
       * `Edit` issued alongside a slow `Bash` should not report the Bash it was
       * batched with. Null when nothing is out.
       */
      const runningToolActivity = (): string | null => {
        let latest: string | null = null;
        for (const name of openMainTools.values()) {
          latest = name;
        }
        return latest === null ? null : `running ${latest}`;
      };
      /**
       * What to say when the MAIN thread is not itself running a tool: either
       * the background work being waited on, or nothing.
       *
       * Null leaves the run's own "Working…" standing, which is the honest
       * phrase for an agent that is simply thinking.
       */
      const idleActivity = (): string | null => {
        const count = heldOnBackgroundWork;
        if (count === 0) {
          return null;
        }
        return `waiting on ${count} background task${count === 1 ? '' : 's'}`;
      };
      const enqueue = (work: () => Promise<void>): void => {
        chain = chain.then(work).catch((err: unknown) => {
          eventHandlingFailed = true;
          this.logger.error(
            `run ${runId} event handling failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      };

      // Asked of the adapter, never inferred from the agent kind: the answer
      // is per-INSTALLED-BINARY (an older claude rejects the flag on argv).
      const streamPartials = await adapter
        .supportsLiveStream()
        .catch(() => false);
      if (!this.registry.canStart(runId)) {
        throw new ConflictException(
          'RUN_STOPPING',
          'daemon shutdown started before the agent could launch',
        );
      }
      // The last check before this turn acquires a finalizer, and it covers BOTH
      // shapes of the race the awaits above open up:
      //   - a delete still in flight (rows not yet gone) — `deleting`;
      //   - a delete that already FINISHED while we were probing — the run row
      //     is gone, and `deleting` has been cleared again, so only re-reading
      //     it catches this one.
      // Either way, spawning now would write a whole turn's rows for a run that
      // no longer exists, which no later delete could ever reach.
      // The re-read is resolved FIRST, and `deleting` is consulted only after
      // it: `||` would short-circuit, evaluating the Set BEFORE suspending on
      // the read, so a delete that set the flag during that suspension would be
      // missed by both halves — the flag was checked too early and the row was
      // read too early to be gone yet. Post-await, the Set catches every
      // in-flight delete (it is set before any row is destroyed) and the null
      // read catches every completed one, with no await left between the check
      // and `register`.
      const runStillExists =
        (await this.runDao.getById(runId, this.em.fork())) !== null;
      if (this.deleting.has(runId) || !runStillExists) {
        throw new ConflictException(
          'RUN_DELETING',
          'this chat was deleted while the turn was starting',
        );
      }
      // Through the session registry, never `adapter.start`: a chat is the one
      // run kind that sends turn after turn to the same agent in the same
      // folder, so its CLI process is kept between them. That is what stops
      // every message re-booting the user's MCP servers — and whatever one of
      // them owns, up to a browser they are logged into.
      const handle = this.sessions.startTurn(
        runId,
        adapter,
        {
          prompt: text,
          cwd,
          model,
          effort,
          configDir,
          customInstructions,
          resumeSessionId,
          approvalMode,
          // A human is watching a chat: let the agent ask, and stream its
          // words as they are written. Each adapter decides what that costs —
          // a CLI without either capability spawns exactly as before.
          allowUserQuestions: true,
          streamPartials,
          images: attachments.map((attachment) => ({
            path: this.attachments.pathOf(runId, attachment.id),
            mediaType: attachment.mediaType,
          })),
          // Tee this turn's raw stdio for the live terminal mirror. Keyed by
          // the same single-agent node the rest of a chat's per-node state is.
        },
        (event) => {
          // Serialize handling so seq allocation and writes stay ordered even
          // though onEvent is a sync callback firing as stdout arrives.
          enqueue(async () => {
            if (event.type === 'session') {
              await saveSessionId(event.sessionId);
              return;
            }
            if (event.type === 'text_delta') {
              // EPHEMERAL: no seq, no row, no replay — just the live tail.
              //
              // MAIN THREAD ONLY. There is exactly ONE tail per run, so two
              // sub-agents writing at once interleave into it character by
              // character and the result is nobody's words. Skipping them loses
              // nothing durable: the completed `text` event still becomes a row,
              // marked as that sub-agent's. Only the live PREVIEW is reserved
              // for the agent the user is addressing. Per-thread tails would
              // need a renderer surface to show them in — a feature, not this.
              if (event.parentToolUseId !== undefined) {
                return;
              }
              this.partials.append(runId, SINGLE_AGENT_NODE, null, event.text);
              return;
            }
            if (event.type === 'thinking_progress') {
              // EPHEMERAL, like a text delta: the only honest signal during a
              // silent reasoning stretch, since the text itself is redacted.
              // Main thread only, for the same reason — one counter per run.
              if (event.parentToolUseId !== undefined) {
                return;
              }
              this.partials.thinking(
                runId,
                SINGLE_AGENT_NODE,
                null,
                event.tokens,
              );
              return;
            }
            if (event.type === 'context_progress') {
              // BEFORE the figure it scales, so the delta this publishes
              // already carries both halves: `context` publishes, and a window
              // remembered after it would not reach the client until the NEXT
              // reading — which for a CLI reporting one figure per turn is a
              // whole turn of a ring with a numerator and no denominator.
              if (
                event.contextWindowTokens !== undefined &&
                event.contextWindowTokens !== null
              ) {
                this.partials.rememberWindow(
                  runId,
                  SINGLE_AGENT_NODE,
                  event.contextWindowTokens,
                  event.contextModel ?? null,
                );
              }
              // EPHEMERAL, like the deltas above: the durable copy is the
              // turn_complete usage. This is what lets the meter move DURING
              // the turn instead of only when it ends.
              this.partials.context(
                runId,
                SINGLE_AGENT_NODE,
                null,
                event.contextTokens,
              );
              return;
            }
            if (event.type === 'turn_model') {
              // Named at session start, before any usage exists — this is what
              // lets a run's FIRST request be scaled against the real window
              // rather than an assumed one, provided some turn of that model
              // has finished at least once this session.
              this.partials.useModel(
                runId,
                SINGLE_AGENT_NODE,
                adapter.getConfig().kind,
                event.model,
              );
              return;
            }
            if (event.type === 'turn_complete') {
              // The ONLY line carrying the model's window. Remembered so the
              // next turn's live context figure has something to scale
              // against from its very first request — under the model that
              // REPORTED it, so a turn that fell back to a second model
              // cannot file that model's window under the requested one.
              this.partials.rememberWindow(
                runId,
                SINGLE_AGENT_NODE,
                event.usage?.contextWindowTokens ?? null,
                event.usage?.contextModel ?? null,
              );
            }
            if (event.type === 'slash_commands') {
              // The CLI's own invokable set for this cwd — feeds the
              // composer's `/` autocomplete, never the transcript.
              this.skillHarvest.record(
                adapter.getConfig().kind,
                cwd,
                event.commands,
              );
              return;
            }
            if (event.type === 'mcp_servers') {
              // What this turn actually loaded here — feeds the MCP panel so
              // it need not re-dial every server to answer, never the
              // transcript. A chat turn carries no config directory (only a
              // graph node does), which is the null.
              this.mcpHarvest.record(
                adapter.getConfig().kind,
                cwd,
                null,
                event.servers,
              );
              return;
            }
            if (event.type === 'context_compacted') {
              // Announced rather than persisted, at every phase, because what
              // each explains is momentary: first a long pause with nothing
              // happening on screen, then the context meter dropping by most of
              // the window between one request and the next. The next tool call
              // replaces whichever phrase is standing.
              //
              // The `started` phrase is the one the user actually asked for. A
              // compaction measured 46s in the probe behind
              // `CLAUDE_COMPACTING_STATUS`, and for that whole time the row said
              // only "Working…" with a climbing timer — the reported defect.
              //
              // `failed` announces NULL, which is what takes the present-tense
              // phrase back down. Saying nothing is right here rather than
              // saying "compaction failed": the durable `system` row already
              // carries the CLI's own reason, and the activity channel describes
              // what the run is DOING — after a refusal it is back to whatever
              // it was doing before.
              //
              // MAIN THREAD ONLY, like the `tool_call` announce below and for
              // the same measured reason: a sub-agent's events arrive on this
              // same stream, and letting one rename the parent's activity was
              // already fixed once there.
              if (event.parentToolUseId !== undefined) {
                return;
              }
              if (event.phase === 'finished') {
                // Kept for the summary line that follows (see `compactedTokens`).
                // Only the finished phase carries metadata — `started` is a bare
                // status line and `failed` never got as far as compacting.
                compactedTokens = {
                  preTokens: event.preTokens,
                  postTokens: event.postTokens,
                };
              }
              this.announceActivity(
                runId,
                event.phase === 'failed'
                  ? null
                  : event.phase === 'started'
                    ? 'compacting the conversation'
                    : event.trigger === 'manual'
                      ? 'compacted the conversation'
                      : 'compacted the conversation to free up context',
              );
              return;
            }
            // Anything durable ends a silent reasoning stretch — the tool call
            // the model went quiet to prepare is the commonest one, and it
            // carries no text delta to close it (see `endThinking`). Before the
            // persist, so the row stops saying "Thinking…" as the tool row
            // lands rather than a write later.
            //
            // MAIN THREAD ONLY, like every other write into this plane: there
            // is one stretch per run and it belongs to the agent the user is
            // addressing. A delegate's rows arrive on this same stream while
            // the parent is genuinely still reasoning, so letting one close the
            // stretch took the "Thinking…" row away from an agent that had not
            // stopped.
            if (event.parentToolUseId === undefined) {
              this.partials.endThinking(runId, SINGLE_AGENT_NODE, null);
            }
            if (event.type === 'turn_held') {
              // ABOVE the `mapEventToItem` gate below, and it has to stay
              // there: this event yields no ROW, so the `if (!mapped) return`
              // is exactly what it falls into. Placed after it, the tally never
              // counts anything and the phrase never appears — which is how the
              // first version of this branch was written.
              heldOnBackgroundWork = event.open;
              // The agent has stopped talking, so nothing it was doing is still
              // true — a tool left open by a turn that ended is not running.
              openMainTools.clear();
              this.announceRunHold(runId, event.open, idleActivity());
              return;
            }
            // Above the row gate for the same reason `turn_held` is: this is
            // bookkeeping the OFF-turn plane reads later, and a delegate whose
            // whole life fits inside its turn is bracketed only here.
            this.recordDelegateBracket(runId, event);
            const mapped = mapEventToItem(event);
            if (!mapped) {
              return;
            }
            if (
              event.type === 'notice' &&
              event.origin === 'cli' &&
              compactedTokens !== null
            ) {
              // The relayed text is the compaction's SUMMARY, and this is the one
              // place that knows it — the mapper sees one line at a time and the
              // renderer sees only what is persisted.
              //
              // TWIN PARSER: `apps/ui/src/renderer/chats/compaction-payload.ts`
              // reads this `compaction` key back to title the collapsed row. An
              // item payload is `z.unknown()` on the wire BY DESIGN, so no
              // generated type spans the two sides — renaming the key here means
              // renaming it there.
              mapped.payload = {
                ...mapped.payload,
                compaction: compactedTokens,
              };
              // Spent. A second CLI-authored notice in the same turn is not this
              // compaction's summary, and must not inherit its figures.
              compactedTokens = null;
            }
            if (
              event.type === 'tool_call' &&
              event.parentToolUseId === undefined
            ) {
              // What "running" actually means right now, for a badge the user
              // is not looking at.
              //
              // MAIN THREAD ONLY. A sub-agent's tool calls arrive on this same
              // stream, and announcing them renamed the parent run's activity
              // after work that is not the parent's — measured on a real
              // delegating turn, eight consecutive `running Bash` announces
              // that all belonged to two sub-agents. The transcript already
              // keeps their rows in their own blocks; this is the one channel
              // that still leaked them upward.
              //
              // What the badge shows instead is the `running Agent` this same
              // branch announced when the delegating tool call started, which
              // stands until the parent itself does something else — and
              // "running Agent" is the truth for the whole delegation.
              openMainTools.set(event.id, event.name);
              this.announceActivity(runId, `running ${event.name}`);
            }
            if (
              event.type === 'tool_result' &&
              event.parentToolUseId === undefined
            ) {
              // The tool is DONE, so stop saying it is running.
              //
              // Without this the phrase set above is never taken down: it is
              // only ever replaced by the NEXT tool call, so the last tool of a
              // turn keeps its present tense for as long as the turn lasts.
              // That is what put "running Read · 7m 57s" under a finished
              // answer on a turn held open by background work — a claim that
              // was false twice over, since the read had returned minutes
              // earlier and nothing was reading anything.
              //
              // Null rather than a phrase of its own: what the agent does
              // between tools is think, which is exactly what the run's own
              // "Working…" already says. Inventing "thinking" here would also
              // be a guess — the turn may equally be waiting on background work
              // it started.
              //
              // MAIN THREAD ONLY, on the same measured reason as the announce
              // above: a delegate's tool results arrive on this stream too, and
              // clearing on one would take down the parent's "running Agent"
              // while the delegation is still running.
              //
              // ...and only once this call's SIBLINGS have returned too. A
              // batch issued in one assistant message returns one result at a
              // time, so retiring the phrase on the first of them reports a
              // still-running `Edit` as idle — see `openMainTools`.
              openMainTools.delete(event.id);
              this.announceActivity(
                runId,
                runningToolActivity() ?? idleActivity(),
              );
            }
            if (event.type === 'approval_request') {
              const isQuestion = isUserQuestion(
                adapter.getConfig().questionToolName,
                event.toolName,
              );
              if (!isQuestion && event.requiresUserInteraction === true) {
                // Flag-only drift: a tool we don't recognize as THE question
                // tool claims it needs the user. It stays on the approval path
                // (card, or the auto-approve below) so a future interactive
                // tool can never silently acquire a human gate it shouldn't
                // have — but the drift is loud. Mirrors the executor's warning.
                this.logger.warn(
                  `interactive control_request for unrecognized tool '${event.toolName}' on run ${runId} — kept on the approval path`,
                );
              }
              if (autoApproves(event.toolName, approvalMode)) {
                // The daemon-side stand-in for --dangerously-skip-permissions.
                // An auto chat spawns on the stdio dialogue ONLY so the
                // question channel survives (buildArgs), so every plain
                // permission is approved here with its input unchanged and no
                // transcript item — auto stays exactly as unattended as before.
                //
                // This reply is QUEUED, unlike the user-verdict path below: it
                // sits behind every pending DB write on the same `enqueue`
                // chain. `delivered` is false when the turn settled underneath
                // it, which is worth a line — a silent false here would look
                // like the agent ignoring its own approval.
                const delivered = handle.respondApproval(
                  event.id,
                  true,
                  event.input,
                );
                if (!delivered) {
                  this.logger.warn(
                    `run ${runId} auto-approval for '${event.toolName}' was not delivered — the turn had already settled`,
                  );
                }
                return;
              }
              // The CLI is now parked waiting for a verdict. Persist the card
              // first (persist-then-emit, so the user sees it), then track it
              // under the chat's one synthetic node so the WS verdict
              // round-trip resolves it. If persisting the card FAILS the user
              // will never see it — so deny to unblock the parked CLI, letting
              // handle.done resolve and the finalizer record a clean failure
              // rather than hang forever on a verdict that can never arrive
              // (a parked ask-mode turn never exits on its own).
              try {
                await this.persist(
                  em,
                  runId,
                  await this.seqs.reserve(runId),
                  mapped.kind,
                  mapped.role,
                  mapped.payload,
                );
              } catch (err) {
                handle.respondApproval(event.id, false, undefined);
                throw err;
              }
              this.approvals.track({
                runId,
                nodeId: SINGLE_AGENT_NODE,
                requestId: event.id,
                toolName: event.toolName,
                input: event.input,
                question: isQuestion,
                respond: (allow, answer) => {
                  const delivered = handle.respondApproval(
                    event.id,
                    allow,
                    foldApprovalAnswer(
                      adapter,
                      event.toolName,
                      event.input,
                      allow,
                      answer,
                    ),
                  );
                  // The entry is already out of the registry by the time this
                  // runs (resolve() deletes before responding), so re-reading it
                  // reports what is STILL open — nothing, unless this turn holds
                  // another card. Announced whether or not the verdict was
                  // delivered: an undeliverable one means the turn settled
                  // underneath the card, which is equally not-parked.
                  //
                  // …and it carries what the run goes BACK to doing, because
                  // the tool the user just approved announced itself before the
                  // card went up and will not announce itself again.
                  this.announceAwaiting(
                    runId,
                    runningToolActivity() ?? idleActivity(),
                  );
                  if (delivered) {
                    enqueue(async () => {
                      await this.persist(
                        em,
                        runId,
                        await this.seqs.reserve(runId),
                        'approval_verdict',
                        null,
                        {
                          id: event.id,
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
                        },
                      );
                    });
                  }
                  return delivered;
                },
              });
              // Parked on the user — announced AFTER the track, so the registry
              // it reads already holds this card. Two things at once, and both
              // matter: the badge stops saying "running" (nothing will move
              // without the user, and a spinner in the sidebar of a chat they
              // are not looking at is the reported complaint), and the line
              // under it says which kind of answer is wanted.
              this.announceAwaiting(runId);
              // An approval_request is never terminal — nothing else to do.
              return;
            }
            await this.persist(
              em,
              runId,
              await this.seqs.reserve(runId),
              mapped.kind,
              mapped.role,
              mapped.payload,
            );
            // ONLY a message retires the tail: it is the durable copy of the
            // very words being streamed. Retiring on any item would let a
            // terminal one (turn_cancelled/error) erase the tail a moment
            // before the finalizer flushes it — the text the user watched
            // would vanish from the replayed transcript.
            //
            // …and only the MAIN thread's message, which is the same rule
            // `text_delta` follows above. There is one tail per run and it
            // holds the words the user is watching appear; a DELEGATE's
            // message is the durable copy of text that was never in it, so
            // retiring on one threw away the head of a sentence the main
            // agent was still writing. That is the reported "он начал
            // стримить сообщения, а потом обрезал первую часть и достримил
            // вторую" — the bubble restarted mid-word, and the whole message
            // only appeared when its own durable row landed at the end. The
            // screenshot's turn had a sub-agent producing rows throughout,
            // which is exactly when it bites.
            if (
              mapped.kind === 'message' &&
              event.parentToolUseId === undefined
            ) {
              this.partials.retire(runId, SINGLE_AGENT_NODE, null);
              if (mapped.role === 'assistant') {
                // Straight off the mapped payload, which is the shape the row
                // is written from — no re-read, no second reading of what a
                // message IS.
                const text = (mapped.payload as { text?: unknown }).text;
                lastAgentText =
                  typeof text === 'string' && text.trim() !== ''
                    ? text
                    : lastAgentText;
              }
            }
            const status = terminalStatus(event);
            if (status === null) {
              // The row this turn just produced, tallied for `housekeeping`.
              // The compaction summary is identified by the MARKER stamped
              // above and never by its text: a CLI free to reword "This
              // session is being continued…" would silently stop matching.
              if (
                (mapped.payload as { compaction?: unknown }).compaction !==
                undefined
              ) {
                compactionRows += 1;
              } else if (mapped.kind !== 'message' || mapped.role !== 'user') {
                // The prompt that ASKED for the compaction is not work — it is
                // the user talking. Everything else the agent produced is.
                workRows += 1;
              }
            }
            if (status) {
              // What the settle SAYS, for whoever is not looking at this chat.
              // A failure speaks for itself; a completion is summarised by the
              // agent's own closing words, which is the only text that answers
              // "what happened" without opening the thread.
              await this.setRunStatus(em, runId, status, {
                summary: event.type === 'error' ? event.message : lastAgentText,
                housekeeping: compactionRows > 0 && workRows === 0,
              });
              // Spent — the tally describes ONE turn, so anything arriving
              // after this ending is counted from zero rather than inheriting
              // a compaction that belonged to the turn before it.
              compactionRows = 0;
              workRows = 0;
              // Set only after the write succeeds: if it throws, the finalizer
              // still writes a synthetic completion rather than leaving 'running'.
              sawTerminal = true;
            }
          });
        },
        // This turn's answer for a request that arrives after it settles —
        // literally the same predicate the in-turn branch uses, so a tool call
        // cannot be judged one way inside the turn and the other way a moment
        // later. The registry installs it on EVERY turn, spawn or reuse, so the
        // posture is the one the user most recently chose rather than the one
        // the session was opened with.
        //
        // Everything else returns null, which HOLDS the request for the next
        // turn to adopt as an ordinary card, rather than refusing it. A refusal
        // reached the agent as the user's own "no" for a card nobody rendered —
        // which is how an `auto` chat came to report that it had lost write
        // access to the worktree.
        ({ toolName }) =>
          autoApproves(toolName, this.runPosture.get(runId)) ? true : null,
        (event) => {
          void this.handleBetweenTurnEvent(
            runId,
            adapter.getConfig().kind,
            cwd,
            event,
          );
        },
        // A chat HAS a card surface, so a request the posture above will not
        // decide is shown rather than held — see {@link raiseHeldApproval} for
        // the run that was lost to holding one.
        (event, respond) =>
          this.raiseHeldApproval(runId, adapter, event, respond),
      );
      this.registry.register(runId, handle);
      // How a mid-turn approval change reaches THIS turn's own seam. The
      // closure variable above is what the auto-approve branch reads on every
      // `approval_request`, so telling the CLI alone would leave the daemon
      // half of the posture on the mode the turn started with — an `auto`
      // turn switched to `ask` would keep auto-approving even though the CLI
      // had begun asking.
      this.liveApproval.set(runId, (mode) => {
        // The CLI FIRST, and only adopt the mode it accepted. The reverse
        // order would move the daemon's own gate for a change the running
        // turn never received.
        if (!handle.setApprovalMode(mode)) {
          return false;
        }
        approvalMode = mode;
        // The run's posture moves with the turn's, so a mode changed mid-turn
        // still governs a request that arrives once this turn has settled.
        this.runPosture.set(runId, mode);
        return true;
      });

      const finalized = handle.done
        .then(async () => {
          await chain; // drain pending persists before finalizing
          // Sweep BEFORE the branches below — the failure path early-returns,
          // and a settled turn must never leave a pending card that no
          // verdict can ever reach. Each swept request is SAID so in the
          // transcript: dropping it silently is what left the card on screen
          // with live buttons that answer into nothing.
          for (const approval of this.approvals.sweepNode(
            runId,
            SINGLE_AGENT_NODE,
          )) {
            await this.persist(
              em,
              runId,
              await this.seqs.reserve(runId),
              'unanswerable',
              null,
              unanswerablePayload(approval),
            ).catch((err: unknown) => {
              this.logger.error(
                `run ${runId} unanswerable item write failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
          // A turn that died mid-block leaves text the user WATCHED being
          // written but that no durable item covers. Persist it once, flagged,
          // so an afterSeq replay shows the same transcript they saw. The only
          // item row the live plane is ever allowed to create.
          const tail = this.partials.takeTail(runId, SINGLE_AGENT_NODE, null);
          if (tail !== null) {
            await this.persist(
              em,
              runId,
              await this.seqs.reserve(runId),
              'message',
              'assistant',
              { text: tail, partial: true },
            ).catch((err: unknown) => {
              this.logger.error(
                `run ${runId} partial-text flush failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
          this.partials.clearRun(runId);
          // The turn is over, so nothing is being held for anything. Cleared
          // on EVERY settle path (the finalizer runs for a failure and a cancel
          // too), or a run that was held when it died would keep telling every
          // window that opens afterwards that its agent is idle and waiting.
          this.heldRuns.delete(runId);
          if (eventHandlingFailed) {
            const message = 'run event persistence failed';
            await this.setRunStatus(em, runId, 'failed').catch(
              (err: unknown) => {
                this.logger.error(
                  `run ${runId} failure-status write failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              },
            );
            await this.persist(
              em,
              runId,
              await this.seqs.reserve(runId),
              'error',
              null,
              { message },
            ).catch((err: unknown) => {
              this.logger.error(
                `run ${runId} terminal failure item write failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
            return;
          }
          if (!sawTerminal) {
            // The turn ended with no terminal event (e.g. a clean exit with no
            // result line). Persist+emit a synthetic turn_complete so the client
            // always receives a terminal item and never wedges waiting for one.
            await this.persist(
              em,
              runId,
              await this.seqs.reserve(runId),
              'turn_complete',
              null,
              { usage: null, stopReason: null },
            );
            await this.setRunStatus(em, runId, 'completed').catch(
              (err: unknown) => {
                this.logger.error(
                  `run ${runId} synthetic-completion status write failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              },
            );
          }
        })
        .catch((err: unknown) => {
          this.logger.error(
            `run ${runId} turn finalize failed: ${String(err)}`,
          );
        });
      // Published so `delete` can wait for this turn's LAST write rather than
      // for its child's exit. Dropped on settle, and only if this exact turn is
      // still the tracked one — a fast follow-up turn must not have its
      // finalizer cleared by its predecessor's.
      this.finalizing.set(runId, finalized);
      void finalized.finally(() => {
        if (this.finalizing.get(runId) === finalized) {
          this.finalizing.delete(runId);
        }
      });
      // Dropped on the same settle, so a PATCH arriving after the turn ends
      // takes the plain persist-only path instead of writing into a dead
      // closure and reporting the change as live.
      void handle.done.finally(() => this.liveApproval.delete(runId));

      return userWire;
    } catch (err) {
      // Failed before the handle took over the slot's lifecycle — drop the claim
      // so the run is not wedged as permanently busy.
      await this.setRunStatus(em, runId, 'failed').catch(
        (statusErr: unknown) => {
          this.logger.error(
            `run ${runId} start-failure status write failed: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`,
          );
        },
      );
      this.registry.release(runId);
      throw err;
    }
  }

  /**
   * Hand a message to the turn that is ALREADY running, or refuse so the
   * caller can queue it.
   *
   * The order is deliberate and is the whole safety of this path: the CLI gets
   * the message FIRST, and only a delivery it confirmed is written to the
   * transcript. Persisting first and then failing to deliver would leave a user
   * message on screen that no agent ever received — the silent failure this is
   * meant to replace — while the reverse loses at worst a transcript row for a
   * message the agent is demonstrably answering.
   *
   * A refusal is a plain RUN_BUSY, identical to the one the claim used to
   * throw, so a CLI with no mid-turn channel needs no special handling
   * anywhere above: the renderer queues it and drains on settle exactly as
   * before.
   */
  private async deliverIntoRunningTurn(
    runId: string,
    text: string,
    images: SendMessageImage[],
  ): Promise<ItemWire> {
    const busy = new ConflictException(
      'RUN_BUSY',
      'a turn is already in progress for this run',
    );
    // Null for a run that is only CLAIMED — reserved microseconds ago by a
    // concurrent send, with no process to write to yet.
    const handle = this.registry.runningHandle(runId);
    if (!handle) {
      throw busy;
    }
    // Written before the send because the payload the adapter builds reads
    // these files. A delivery that then fails leaves them unreferenced under
    // the run's own attachments directory, which its teardown removes wholesale
    // — the same place a failed first-turn send already leaves them.
    const attachments = images.map((image) =>
      this.attachments.save(runId, image.mediaType, image.data),
    );
    const delivered = handle.sendUserMessage({
      text,
      images: attachments.map((attachment) => ({
        path: this.attachments.pathOf(runId, attachment.id),
        mediaType: attachment.mediaType,
      })),
    });
    if (!delivered) {
      throw busy;
    }
    const em = this.em.fork();
    // Its OWN seq, allocated now: the follow-up belongs after everything the
    // turn has already written, not at the position it would have had when the
    // user pressed send.
    //
    // From the run's ALLOCATOR, never from `maxSeq`. This is the exact seam
    // the duplicate-seq defect lived in: the turn running underneath this call
    // holds reservations the table cannot show, so a database read handed this
    // message the number the turn had already claimed for its next item — and
    // the renderer, which de-dupes by seq, then dropped whichever arrived
    // second. That was reliably the agent's reply, which is why the reported
    // symptom was "it deletes its last message".
    const seq = await this.seqs.reserve(runId);
    return this.persist(em, runId, seq, 'message', 'user', {
      text,
      ...(attachments.length > 0 ? { images: attachments } : {}),
      // NOT stamped with how it was sent. A `midTurn: true` flag used to ride
      // here so the renderer could caption the row ("Sent into the turn already
      // running — the agent picks this up when its current step finishes"),
      // explaining why a message written behind a long tool call sits there
      // while the live row goes on naming the tool that was already running.
      // The caption was reported as noise under every such message and removed,
      // and the flag went with it rather than staying as a key nothing reads —
      // a payload key with no reader is indistinguishable from one whose reader
      // was lost. Bringing the explanation back means bringing both back.
    });
  }

  private async persist(
    em: EntityManager,
    runId: string,
    seq: number,
    kind: ItemKind,
    role: string | null,
    payload: unknown,
  ): Promise<ItemWire> {
    return persistItemAndEmit({ itemDao: this.itemDao, bus: this.bus }, em, {
      runId,
      nodeId: null,
      seq,
      kind,
      role,
      payload,
    });
  }

  /**
   * The run row for the wire, with its live "parked on the user" reading folded
   * in from the registry.
   *
   * Every chat route projects through here, so the snapshot a reconnecting
   * window loads agrees with the `run_status` broadcasts it will then receive —
   * a run parked on a question emits nothing further by definition, so a client
   * that missed the transition has only this to learn it from.
   */
  private toRunWire(run: Run, lastMessage: string | null = null): RunWire {
    return runToWire(
      run,
      lastMessage,
      this.approvals.awaitingFor(run.id),
      this.heldRuns.get(run.id) ?? 0,
    );
  }

  private itemToWire(item: Item): ItemWire {
    return {
      id: item.id,
      runId: item.runId,
      nodeId: item.nodeId,
      seq: item.seq,
      kind: item.kind,
      role: item.role,
      payload: parsePayload(item.payload),
      createdAt: item.createdAt.toISOString(),
    };
  }
}
