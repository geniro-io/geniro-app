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
import { mapEventToItem, terminalStatus } from '../utils/event-to-item';
import { persistItemAndEmit, runToWire } from '../utils/persist-item';
import { resolveValidConfigDir } from '../utils/resolve-config-dir';
import { resolveValidCwd } from '../utils/resolve-cwd';
import { assertChatRun } from '../utils/run-kind';
import { writeRunStatus } from '../utils/run-status';
import { createSessionIdSaver } from '../utils/session-saver';
import { unanswerablePayload, unansweredRequests } from '../utils/unanswerable';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { ApprovalRegistry } from './approval-registry';
import { AttachmentStoreService } from './attachment-store.service';
import { EffortsService } from './efforts.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { McpHarvestStore } from './mcp-harvest.store';
import { PartialStreamService } from './partial-stream.service';
import { ProcessRegistry } from './process-registry';
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
    activity: string | null = null,
  ): Promise<void> {
    await writeRunStatus(
      { runDao: this.runDao, bus: this.bus },
      em,
      runId,
      status,
      activity,
    );
  }

  /**
   * Announce what a run is DOING, without touching its status.
   *
   * "running" alone cannot tell an agent that is working from one parked on a
   * question nobody has answered — which is the whole of the reported
   * complaint about the badge.
   *
   * `status: null` is what makes "without touching its status" true. This
   * fires from inside a turn's event stream, on every tool call, and never
   * reads the run — so the `'running'` it used to send was a guess, and the
   * client wrote that guess onto the row. One straggler event arriving after a
   * cancel or a terminal write therefore flipped the badge back to running and
   * left it there, with nothing announcing again to correct it.
   */
  private announceActivity(runId: string, activity: string | null): void {
    this.bus.publishRunStatus({ runId, status: null, activity });
  }

  async createChat(input: {
    agentKind: AgentKind;
    cwd: string;
    model?: string;
    title?: string;
    approval?: ChatApprovalMode;
    effort?: string;
    configDir?: string;
  }): Promise<RunWire> {
    const cwd = resolveValidCwd(input.cwd);
    this.assertApprovalSupported(input.agentKind, input.approval);
    this.assertEffortSupported(input.agentKind, input.effort ?? null);
    // Canonicalized HERE, at the one moment the value is chosen, so the row
    // holds the path that was actually checked — the same contract `cwd` above
    // has. Each turn re-resolves it anyway (a directory can be deleted between
    // creation and a turn), which is what keeps a vanished profile from
    // reaching the child, where claude would CREATE it and report a login
    // failure about a directory nobody meant to name.
    const configDir = this.resolveConfigDir(input.agentKind, input.configDir);
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
        title: input.title ?? null,
        // New chats always carry an explicit mode; only pre-selector rows
        // stay null.
        approval: this.initialApproval(input.agentKind, input.approval),
      },
      em,
    );
    return this.toRunWire(run);
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
      this.assertEffortSupported(run.agentKind, patch.effort);
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
  ): void {
    if (effort === null || agentKind === null) {
      return;
    }
    if (!this.efforts.accepts(agentKind, effort)) {
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
   * Write an event the CLI produced with no turn in flight into the run's
   * transcript.
   *
   * Only the two halves of a tool call, and the narrowness is the whole safety
   * argument. Each carries the id that pairs them, so neither can be attributed
   * to the wrong work; anything else arriving here (a stray message, a delta)
   * has no such anchor, and filing one turn's words under another's is worse
   * than dropping them. That is why `spawn-cli` hands these over rather than
   * replaying them into the next turn, and why this filters rather than
   * persisting whatever it is given.
   *
   * Without it the row stayed unpaired forever: the renderer now stops
   * SPINNING over one (the group's turn has ended), but the result itself was
   * simply gone, so expanding the row showed a call with no answer.
   *
   * The `tool_call` half is needed because a call can arrive between turns too
   * — a Stop leaves the CLI starting one more tool — and dropping it while
   * keeping its result leaves the result unpairable. `transcript-groups` pairs
   * in a single forward pass keyed on the call id, so a result whose call is
   * absent renders as its own top-level row: the bare `RESULT` blocks a user
   * reported as strange messages after a Stop, one holding a `tool_reference`
   * payload and one holding raw `mcp list` output. Both halves arrive in order
   * and take their seq in that order, so persisting both restores the pairing.
   *
   * Run-scoped by construction — its own `em` fork and the run's seq
   * allocator, nothing borrowed from a turn that has already settled. Failure
   * is logged and swallowed: this is called from the session's event path,
   * where a throw has no caller to reach.
   */
  private async persistBetweenTurnEvent(
    runId: string,
    event: AgentEvent,
  ): Promise<void> {
    if (event.type !== 'tool_result' && event.type !== 'tool_call') {
      this.logger.warn(
        `run ${runId} dropped a '${event.type}' event arriving between turns`,
      );
      return;
    }
    const mapped = mapEventToItem(event);
    if (!mapped) {
      return;
    }
    try {
      await this.persist(
        this.em.fork(),
        runId,
        await this.seqs.reserve(runId),
        mapped.kind,
        mapped.role,
        mapped.payload,
      );
    } catch (err: unknown) {
      this.logger.error(
        `run ${runId} failed to persist a between-turn ${event.type}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
      await this.setRunStatus(em, runId, 'running');

      let chain: Promise<void> = Promise.resolve();
      let sawTerminal = false;
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
            this.partials.endThinking(runId, SINGLE_AGENT_NODE, null);
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
              this.announceActivity(runId, `running ${event.name}`);
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
              // Parked on the user. Distinguishable from working, which is
              // the difference a bare "running" badge could never show.
              this.announceActivity(
                runId,
                isQuestion ? 'waiting for your answer' : 'waiting for approval',
              );
              this.approvals.track({
                runId,
                nodeId: SINGLE_AGENT_NODE,
                requestId: event.id,
                toolName: event.toolName,
                input: event.input,
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
            if (mapped.kind === 'message') {
              // ONLY a message retires the tail: it is the durable copy of the
              // very words being streamed. Retiring on any item would let a
              // terminal one (turn_cancelled/error) erase the tail a moment
              // before the finalizer flushes it — the text the user watched
              // would vanish from the replayed transcript.
              this.partials.retire(runId, SINGLE_AGENT_NODE, null);
            }
            const status = terminalStatus(event);
            if (status) {
              await this.setRunStatus(em, runId, status);
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
          void this.persistBetweenTurnEvent(runId, event);
        },
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

  private toRunWire(run: Run, lastMessage: string | null = null): RunWire {
    return runToWire(run, lastMessage);
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
