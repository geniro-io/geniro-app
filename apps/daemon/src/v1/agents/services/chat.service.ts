import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import type { AgentKind, ItemKind } from '../../runs/runs.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAdapter } from '../adapters/cursor/cursor.adapter';
import {
  type ChatApprovalMode,
  type ClaudeModesCapability,
  type ItemWire,
  type RunWire,
  SINGLE_AGENT_NODE,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { answerFoldsInto, foldApprovalAnswer } from '../utils/approval-answer';
import { mapEventToItem, terminalStatus } from '../utils/event-to-item';
import { persistItemAndEmit, runToWire } from '../utils/persist-item';
import { resolveValidCwd } from '../utils/resolve-cwd';
import { assertChatRun } from '../utils/run-kind';
import { createSessionIdSaver } from '../utils/session-saver';
import { AgentEventBus } from './agent-events.bus';
import { ApprovalRegistry } from './approval-registry';
import { ClaudeProbeService } from './claude-probe.service';
import { ProcessRegistry } from './process-registry';
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
    private readonly claudeProbe: ClaudeProbeService,
    private readonly skillHarvest: SkillHarvestStore,
  ) {}

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
        const seq = (await this.itemDao.maxSeq(run.id, em)) + 1;
        await this.persist(em, run.id, seq, 'error', null, {
          message:
            'run interrupted — the daemon stopped before this turn finished',
        });
        await this.runDao.updateById(run.id, { status: 'failed' }, em);
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

  async createChat(input: {
    agentKind: AgentKind;
    cwd: string;
    model?: string;
    title?: string;
    approval?: ChatApprovalMode;
  }): Promise<RunWire> {
    const cwd = resolveValidCwd(input.cwd);
    this.assertApprovalSupported(input.agentKind, input.approval);
    const em = this.em.fork();
    const run = await this.runDao.create(
      {
        workflowId: null,
        status: 'pending',
        agentKind: input.agentKind,
        cwd,
        model: input.model ?? null,
        title: input.title ?? null,
        // New chats always carry an explicit mode (claude defaults to 'ask',
        // cursor is pinned 'auto'); only pre-selector rows stay null.
        approval:
          input.agentKind === 'cursor-agent'
            ? 'auto'
            : (input.approval ?? 'ask'),
      },
      em,
    );
    return this.toRunWire(run);
  }

  /**
   * PATCH /v1/chats/:runId/settings — flip the approval mode between turns.
   * 409 while a turn is in flight (the daemon-side contract matching the
   * disabled selector), 400 for a non-auto mode on a cursor chat.
   */
  async updateSettings(
    runId: string,
    approval: ChatApprovalMode,
  ): Promise<RunWire> {
    const em = this.em.fork();
    const run = assertChatRun(await this.runDao.getById(runId, em), runId);
    this.assertApprovalSupported(run.agentKind, approval);
    // Captured before the write: BaseDao.updateById mutates this same
    // identity-mapped entity, so `run.approval` reflects the NEW value the
    // moment updateById returns — the revert path below needs the old one.
    const previous = run.approval;
    if (this.registry.has(runId)) {
      throw new ConflictException(
        'RUN_BUSY',
        'a turn is in flight — the approval mode is locked until it settles',
      );
    }
    await this.runDao.updateById(runId, { approval }, em);
    // A turn may have claimed the run DURING the write above — after our
    // pre-check but before the flush. sendMessage snapshots the run row in
    // its own fork, so that turn may already be spawning under the pre-write
    // mode. Refuse rather than ACK a mode the in-flight turn won't honor:
    // revert and 409. (A PATCH that fully lands BEFORE the claim is still
    // honored — sendMessage re-reads the committed mode after it claims.)
    if (this.registry.has(runId)) {
      await this.runDao.updateById(runId, { approval: previous }, em);
      throw new ConflictException(
        'RUN_BUSY',
        'a turn started while the approval change was in flight — retry once it settles',
      );
    }
    run.approval = approval;
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

  /** Cursor has no approval callback — cursor chats are pinned to 'auto'. */
  private assertApprovalSupported(
    agentKind: AgentKind | null,
    approval: ChatApprovalMode | undefined,
  ): void {
    if (
      agentKind === 'cursor-agent' &&
      approval !== undefined &&
      approval !== 'auto'
    ) {
      throw new BadRequestException(
        'CURSOR_APPROVAL_UNSUPPORTED',
        "cursor-agent has no approval callback — cursor chats run 'auto' only",
      );
    }
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
    assertChatRun(await this.runDao.getById(runId, em), runId);
    return { cancelled: this.registry.cancel(runId) };
  }

  /**
   * Persist the user message, then start a turn whose streamed events are each
   * persisted-then-emitted. Returns the persisted user item immediately; the
   * agent's reply streams over the bus → WS while this method has already
   * resolved.
   */
  async sendMessage(runId: string, text: string): Promise<ItemWire> {
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
      throw new ConflictException(
        'RUN_BUSY',
        'a turn is already in progress for this run',
      );
    }
    try {
      const cwd = resolveValidCwd(run.cwd);
      const agentKind = run.agentKind;
      const model = run.model ?? undefined;

      // Re-read the committed approval mode from a FRESH fork now that the
      // claim is held: a settings PATCH that flushed to its own fork between
      // the getById above and the claim never mutated `run`, so its ACKed
      // mode would otherwise be ignored. The claim now 409s any later PATCH,
      // and updateSettings reverts a PATCH that raced the claim, so this read
      // reflects exactly the acknowledged mode.
      const committed = await this.runDao.getById(runId, this.em.fork());
      let approvalMode: ChatApprovalMode | undefined =
        committed?.approval ?? run.approval ?? undefined;

      let seq = (await this.itemDao.maxSeq(runId, em)) + 1;
      const userWire = await this.persist(em, runId, seq++, 'message', 'user', {
        text,
      });

      // acceptEdits degrades to 'ask' VISIBLY (persisted system item) when the
      // installed claude can't accept the mode (a probed FAIL); an unprobed
      // `unknown` keeps the requested mode so a genuine CLI rejection stays
      // loud. `plan` is deliberately NOT degraded — converting a no-execute
      // mode into an executing 'ask' would invert its whole promise, so an
      // unsupported 'plan' rides through and the CLI rejects it loudly.
      if (agentKind === 'claude' && approvalMode === 'acceptEdits') {
        const modes = await this.claudeModesSafe();
        if (modes.acceptEdits === 'fail') {
          await this.persist(em, runId, seq++, 'system', null, {
            message:
              "installed claude does not support acceptEdits — this turn runs as 'ask'",
          });
          approvalMode = 'ask';
        }
      }

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
      await this.runDao.updateById(runId, { status: 'running' }, em);

      const adapter: AgentAdapter =
        agentKind === 'claude' ? this.claude : this.cursor;
      let chain: Promise<void> = Promise.resolve();
      let sawTerminal = false;
      let eventHandlingFailed = false;
      const enqueue = (work: () => Promise<void>): void => {
        chain = chain.then(work).catch((err: unknown) => {
          eventHandlingFailed = true;
          this.logger.error(
            `run ${runId} event handling failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      };

      if (!this.registry.canStart(runId)) {
        throw new ConflictException(
          'RUN_STOPPING',
          'daemon shutdown started before the agent could launch',
        );
      }
      const handle = adapter.start(
        { prompt: text, cwd, model, resumeSessionId, approvalMode },
        (event) => {
          // Serialize handling so seq allocation and writes stay ordered even
          // though onEvent is a sync callback firing as stdout arrives.
          enqueue(async () => {
            if (event.type === 'session') {
              await saveSessionId(event.sessionId);
              return;
            }
            if (event.type === 'slash_commands') {
              // The CLI's own invokable set for this cwd — feeds the
              // composer's `/` autocomplete, never the transcript.
              this.skillHarvest.record(cwd, event.commands);
              return;
            }
            const mapped = mapEventToItem(event);
            if (!mapped) {
              return;
            }
            if (event.type === 'approval_request') {
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
                  seq++,
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
                respond: (allow, answer) => {
                  const delivered = handle.respondApproval(
                    event.id,
                    allow,
                    foldApprovalAnswer(
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
                        seq++,
                        'approval_verdict',
                        null,
                        {
                          id: event.id,
                          allow,
                          // Recorded only when it was actually folded — the
                          // transcript must never claim an answer the agent
                          // did not receive.
                          ...(answerFoldsInto(event.toolName, allow, answer)
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
              seq++,
              mapped.kind,
              mapped.role,
              mapped.payload,
            );
            const status = terminalStatus(event);
            if (status) {
              await this.runDao.updateById(runId, { status }, em);
              // Set only after the write succeeds: if it throws, the finalizer
              // still writes a synthetic completion rather than leaving 'running'.
              sawTerminal = true;
            }
          });
        },
      );
      this.registry.register(runId, handle);

      void handle.done
        .then(async () => {
          await chain; // drain pending persists before finalizing
          // Sweep BEFORE the branches below — the failure path early-returns,
          // and a settled turn must never leave a pending card that no
          // verdict can ever reach.
          this.approvals.sweepNode(runId, SINGLE_AGENT_NODE);
          if (eventHandlingFailed) {
            const message = 'run event persistence failed';
            await this.runDao
              .updateById(runId, { status: 'failed' }, em)
              .catch((err: unknown) => {
                this.logger.error(
                  `run ${runId} failure-status write failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
            await this.persist(em, runId, seq++, 'error', null, {
              message,
            }).catch((err: unknown) => {
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
            await this.persist(em, runId, seq++, 'turn_complete', null, {
              usage: null,
              stopReason: null,
            });
            await this.runDao
              .updateById(runId, { status: 'completed' }, em)
              .catch((err: unknown) => {
                this.logger.error(
                  `run ${runId} synthetic-completion status write failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
          }
        })
        .catch((err: unknown) => {
          this.logger.error(
            `run ${runId} turn finalize failed: ${String(err)}`,
          );
        });

      return userWire;
    } catch (err) {
      // Failed before the handle took over the slot's lifecycle — drop the claim
      // so the run is not wedged as permanently busy.
      await this.runDao
        .updateById(runId, { status: 'failed' }, em)
        .catch((statusErr: unknown) => {
          this.logger.error(
            `run ${runId} start-failure status write failed: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`,
          );
        });
      this.registry.release(runId);
      throw err;
    }
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
