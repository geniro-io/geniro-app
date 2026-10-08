import { asArray, asNumber, asRecord, asString } from '../../utils/json-util';
import { ollamaModelName } from '../../utils/ollama';
import type {
  AgentEvent,
  AgentTask,
  AgentTaskStatus,
  AgentTurnInput,
  AgentUsage,
  FollowUpMessage,
} from '../adapter.types';
import {
  decodeRequestId,
  encodeError,
  encodeRequestId,
  encodeResult,
  JSONRPC_METHOD_NOT_FOUND,
  type JsonRpcId,
} from '../utils/json-rpc.utils';
import {
  CODEX_ACTIVE_WRITER_MARKER,
  CODEX_ACTIVE_WRITER_RETRIES,
  CODEX_ACTIVE_WRITER_RETRY_MS,
  CODEX_COMPACT_PROMPT,
  CODEX_DELEGATE_LABEL_MAX_CHARS,
  CODEX_METHODS,
  CODEX_NOTIFICATIONS,
  CODEX_OLLAMA_PROVIDER,
  CODEX_REASONING_SUMMARY,
  CODEX_SERVER_REQUESTS,
  CODEX_STEER_PREVIEW_MAX_CHARS,
} from './codex.const';
import type {
  CodexItem,
  CodexTokenBreakdown,
  CodexTokenUsage,
  CodexTurnPolicy,
} from './codex.types';
import type { CodexSession } from './codex-session';
import {
  codexApprovalCard,
  encodeCodexReply,
  fileChangeStaysIn,
} from './utils/codex-approval.utils';
import {
  codexUserInput,
  finishedAgentsOf,
  firstLine,
  itemCompletedEvents,
  itemStartedEvents,
  readCodexItem,
  receiverThreadsOf,
  spawnsSubagent,
  subAgentActivityOf,
  subagentOutcomeOf,
  subagentState,
} from './utils/codex-items.utils';
import { codexTurnMcpOverrides } from './utils/codex-mcp.utils';
import {
  baselineOf,
  type CodexSpend,
  readTokenUsage,
  spendBetween,
  sumSpends,
  turnUsageOf,
} from './utils/codex-usage.utils';

/** What a frame awaiting a reply was, so the reply can be read. */
export type CodexPendingKind =
  | 'initialize'
  | 'config_read'
  | 'thread_start'
  | 'thread_resume'
  | 'turn_start'
  | 'compact'
  | 'turn_steer'
  | 'turn_interrupt';

/** Everything about ONE turn, derived from that turn's own input. */
export interface CodexTurnOptions {
  input: AgentTurnInput;
  /** The composed instruction block, sent as the thread's developer text. */
  developerInstructions: string;
  /** Thread config overrides — geniro's MCP endpoint — or null for none. */
  config: Record<string, unknown> | null;
  policy: CodexTurnPolicy;
  /**
   * The auto-compaction threshold the PROCESS was spawned with (`-c
   * model_auto_compact_token_limit=N`), or null when geniro set none — kept
   * for the context readout, which has no other way to learn it.
   */
  autoCompactTokens: number | null;
  /**
   * The MCP servers this turn runs without — a workflow node's own switches,
   * geniro's own server already left out. Non-empty makes the thread's opening
   * read codex's config first (`config/read`), because which override reaches
   * a server depends on where codex defines it (`codexTurnMcpOverrides`).
   */
  mcpDisabled: readonly string[];
}

/** codex's plan-step status → the task list's. */
const PLAN_STATUS: Readonly<Record<string, AgentTaskStatus>> = {
  pending: 'pending',
  inProgress: 'in_progress',
  completed: 'completed',
};

/**
 * ONE turn of a codex conversation — the state that must not outlive it.
 *
 * Built fresh per turn by {@link CodexSession}, which holds what does outlive
 * a turn (the process, the request ids, the thread). A field lives here by
 * default; surviving a turn is a deliberate move to the session.
 */
export class CodexTurnDriver {
  /** The turn codex opened for this driver's prompt, once it says which. */
  private turnId: string | null = null;
  /** The newest agent message, carried as the turn's `finalText`. */
  private finalText: string | null = null;
  /** A failure codex reported without retrying, held for the turn's end. */
  private pendingError: string | null = null;
  /** The thread's running total before this turn, from its first reading. */
  private baseline: CodexTokenBreakdown | null = null;
  /** The thread's running total at this turn's previous reading. */
  private previousTotal: CodexTokenBreakdown | null = null;
  /** The context size a compaction started from. */
  private compactingFrom: number | null = null;
  /** A terminal event has been emitted; everything after it is the next turn's. */
  private settled = false;
  /** This turn's `turn/start` carried a collaboration-mode switch. */
  private switchesPlanMode = false;
  /** Times this turn's resume was asked again after an active-writer refusal. */
  private writerRetries = 0;
  /**
   * The thread config that leaves this node's switched-off MCP servers out,
   * once codex's own config has been read — null until then (and for good on a
   * turn that switches nothing off, which never reads it).
   */
  private mcpOverrides: Record<string, unknown> | null = null;

  constructor(
    private readonly session: CodexSession,
    readonly options: CodexTurnOptions,
  ) {}

  private get input(): AgentTurnInput {
    return this.options.input;
  }

  /** This turn is codex's own `/compact`, run as a compaction, not a prompt. */
  private get compacts(): boolean {
    return this.input.prompt.trim() === CODEX_COMPACT_PROMPT;
  }

  // ── Opening ───────────────────────────────────────────────────────────────

  /**
   * The thread this conversation runs in: resumed when the run holds a codex
   * thread id, else started. The instruction block and geniro's MCP endpoint
   * ride here because they belong to the THREAD — a turn has no field for
   * either.
   */
  openThread(events: AgentEvent[]): void {
    const params = this.threadParams();
    const resume = this.input.resumeSessionId?.trim();
    if (this.input.resumeOnly === true && !resume) {
      // Falling through would start a FRESH thread and settle it as a
      // successful reopen — while its id replaced the one the run holds.
      events.push({
        type: 'error',
        message: 'there is no conversation to reopen',
      });
      this.settled = true;
      return;
    }
    if (this.options.mcpDisabled.length > 0 && this.mcpOverrides === null) {
      // Read where codex defines each server first: the override that
      // switches one off differs by where it comes from, and the wrong one
      // fails the whole thread. The reply opens the thread (`config_read`).
      this.session.request(
        CODEX_METHODS.configRead,
        { cwd: this.input.cwd },
        'config_read',
        events,
      );
      return;
    }
    if (resume) {
      this.session.request(
        CODEX_METHODS.threadResume,
        { threadId: resume, ...params },
        'thread_resume',
        events,
      );
      return;
    }
    this.session.request(
      CODEX_METHODS.threadStart,
      params,
      'thread_start',
      events,
    );
  }

  /**
   * Send this turn's prompt on the thread the session holds — a
   * `thread/compact/start` for `/compact`, else a `turn/start` carrying the
   * turn's own settings.
   *
   * Every setting is sent on every turn, because codex keeps a turn's
   * overrides for the turns after it: a turn that sent nothing would run under
   * whatever the previous one asked for.
   */
  beginTurn(events: AgentEvent[]): void {
    const threadId = this.session.threadId;
    if (threadId === null) {
      // This process holds no thread — the resume on its first turn was
      // refused, or it never got one. Open it now; the reply begins the turn.
      this.openThread(events);
      return;
    }
    if (this.input.resumeOnly === true) {
      // The thread is open and nothing is to be asked of it: that IS this
      // turn's whole outcome, and no prompt is ever in flight to end it later.
      this.settled = true;
      events.push({
        type: 'turn_complete',
        usage: null,
        stopReason: null,
        finalText: null,
      });
      return;
    }
    if (this.compacts) {
      this.session.request(
        CODEX_METHODS.threadCompact,
        { threadId },
        'compact',
        events,
      );
      return;
    }
    const { policy } = this.options;
    const collaborationMode = this.session.collaborationModeFor(
      policy.plan,
      ollamaModelName(this.input.model) ?? this.input.model ?? null,
      this.input.effort ?? null,
    );
    this.switchesPlanMode = collaborationMode !== null;
    this.session.request(
      CODEX_METHODS.turnStart,
      {
        threadId,
        input: codexUserInput(this.input.prompt, this.input.images),
        cwd: this.input.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
        ...(this.input.model
          ? { model: ollamaModelName(this.input.model) ?? this.input.model }
          : {}),
        ...(this.input.effort ? { effort: this.input.effort } : {}),
        summary: CODEX_REASONING_SUMMARY,
        ...(collaborationMode ? { collaborationMode } : {}),
      },
      'turn_start',
      events,
    );
  }

  // ── Replies ───────────────────────────────────────────────────────────────

  onReply(kind: CodexPendingKind, result: unknown): AgentEvent[] {
    const events: AgentEvent[] = [];
    switch (kind) {
      case 'config_read': {
        const { config, unreachable } = codexTurnMcpOverrides(
          result,
          this.options.mcpDisabled,
        );
        this.mcpOverrides = config;
        if (unreachable.length > 0) {
          // Not a turn failure: the builder already says which rows codex
          // cannot switch for one turn, and a name it does not load at all is
          // ignored by design.
          this.session.log(
            `codex: left on for this turn — no per-turn switch reaches ${unreachable.join(', ')}`,
          );
        }
        this.openThread(events);
        break;
      }
      case 'thread_start':
      case 'thread_resume': {
        const record = asRecord(result);
        const threadId = asString(asRecord(record?.thread)?.id);
        if (threadId === null) {
          events.push({
            type: 'error',
            message: `codex: the ${kind === 'thread_start' ? 'new' : 'resumed'} thread came back without an id`,
          });
          this.settled = true;
          break;
        }
        this.session.threadId = threadId;
        const model = asString(record?.model);
        if (model) {
          this.session.threadModel = model;
        }
        // A resumed thread keeps the mode its last turn ran in — plan mode
        // included, whatever process ran it — and a fresh one starts outside
        // it. The turn below decides from this whether to switch.
        const mode = asString(asRecord(record?.collaborationMode)?.mode);
        if (mode !== null) {
          this.session.notePlanMode(mode === 'plan');
        } else if (kind === 'thread_start') {
          this.session.notePlanMode(false);
        }
        // What the context readout lists: the instruction files codex says
        // this thread loaded (`instructionSources`), the model, and the
        // threshold this process compacts at.
        this.session.noteFacts({
          instructionSources: asArray(record?.instructionSources).flatMap(
            (path) => {
              const text = asString(path);
              return text ? [text] : [];
            },
          ),
          model: this.session.threadModel,
          autoCompactTokens: this.options.autoCompactTokens,
        });
        events.push({ type: 'session', sessionId: threadId });
        if (this.session.threadModel) {
          events.push({ type: 'turn_model', model: this.session.threadModel });
        }
        this.beginTurn(events);
        break;
      }
      case 'turn_start': {
        const id = asString(asRecord(asRecord(result)?.turn)?.id);
        if (id !== null && this.turnId === null) {
          this.turnId = id;
        }
        if (this.switchesPlanMode) {
          this.session.notePlanMode(this.options.policy.plan);
        }
        break;
      }
      default:
        break;
    }
    return events;
  }

  onErrorReply(
    kind: CodexPendingKind,
    message: string,
    detail: string | null = null,
  ): AgentEvent[] {
    switch (kind) {
      case 'config_read': {
        // The conversation still opens — without the switches, said out loud
        // rather than run on a surface nobody chose.
        this.mcpOverrides = {};
        const events: AgentEvent[] = [
          {
            type: 'notice',
            message: `codex could not read its own config (${message}), so the MCP servers switched off on this node stay on for this turn.`,
          },
        ];
        this.openThread(events);
        return events;
      }
      case 'thread_resume': {
        if (message.includes(CODEX_ACTIVE_WRITER_MARKER)) {
          // A process geniro itself just replaced may take a moment to let go
          // of the thread, so the resume is asked again before anything fails.
          if (this.writerRetries < CODEX_ACTIVE_WRITER_RETRIES) {
            this.writerRetries += 1;
            this.session.schedule(this, CODEX_ACTIVE_WRITER_RETRY_MS, (later) =>
              this.openThread(later),
            );
            return [];
          }
          // The conversation is intact and merely open somewhere else. A fresh
          // thread here would replace the run's session id for good — every
          // later turn would resume the copy — so the turn fails instead, and
          // sending again once that process has gone reopens the real one.
          this.settled = true;
          return [
            {
              type: 'error',
              message: `codex could not open this conversation: another codex process has it open — for example \`codex resume\` in a terminal (${message}). Close that one, then send the message again.`,
            },
          ];
        }
        if (this.input.resumeOnly === true) {
          this.settled = true;
          return [
            {
              type: 'error',
              message: `codex could not reopen this conversation: ${message}`,
            },
          ];
        }
        // The conversation this run holds is not one codex can reopen here —
        // moved, pruned, or from another profile. A fresh thread keeps the chat
        // usable; saying so keeps the lost history from passing unnoticed.
        const events: AgentEvent[] = [
          {
            type: 'notice',
            message: `codex could not reopen this conversation (${message}), so this turn starts a new one without the earlier history.`,
          },
        ];
        this.session.request(
          CODEX_METHODS.threadStart,
          this.threadParams(),
          'thread_start',
          events,
        );
        return events;
      }
      case 'turn_steer':
        // The message is quoted because this can arrive after the turn it was
        // sent into has ended — even after the next one has opened.
        return [
          {
            type: 'notice',
            message: `codex did not take your message${detail ? ` "${detail}"` : ''} into the turn it was sent during (${message}) — send it again.`,
          },
        ];
      case 'turn_interrupt':
        this.session.log(`codex: turn/interrupt was refused: ${message}`);
        return [];
      default:
        // A failed handshake fails every frame pipelined behind it; the first
        // failure is the turn's, the rest would only repeat it.
        if (this.settled) {
          return [];
        }
        this.settled = true;
        return [
          {
            type: 'error',
            message: `codex: ${this.describe(kind)} failed: ${message}`,
          },
        ];
    }
  }

  /** What `thread/start` and `thread/resume` both carry about this turn. */
  private threadParams(): Record<string, unknown> {
    const { policy, config, developerInstructions } = this.options;
    // geniro's endpoint and the node's switched-off servers are both dotted
    // keys, so they merge without either replacing a table of the other's.
    const merged = { ...(config ?? {}), ...(this.mcpOverrides ?? {}) };
    return {
      cwd: this.input.cwd,
      ...(this.input.model
        ? { model: ollamaModelName(this.input.model) ?? this.input.model }
        : {}),
      ...(ollamaModelName(this.input.model)
        ? { modelProvider: CODEX_OLLAMA_PROVIDER }
        : {}),
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      ...(Object.keys(merged).length > 0 ? { config: merged } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
    };
  }

  private describe(kind: CodexPendingKind): string {
    switch (kind) {
      case 'initialize':
        return 'the handshake';
      case 'config_read':
        return 'reading its config';
      case 'thread_start':
        return 'starting the conversation';
      case 'thread_resume':
        return 'reopening the conversation';
      case 'turn_start':
        return 'starting the turn';
      case 'compact':
        return 'compacting the conversation';
      case 'turn_steer':
        return 'adding the message to the turn';
      case 'turn_interrupt':
        return 'stopping the turn';
    }
  }

  // ── Server requests ───────────────────────────────────────────────────────

  onServerRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): AgentEvent[] {
    const card = codexApprovalCard(method, params, this.session.items);
    if (card === null) {
      if (method === CODEX_SERVER_REQUESTS.mcpElicitation) {
        // An MCP server asking the user for input (a form, or a URL to open)
        // — a tool-call APPROVAL got its card above. Declined in-protocol
        // rather than left to hang: codex then reports the tool call as
        // failed and the agent carries on.
        this.session.reply(id, {
          action: 'decline',
          content: null,
          _meta: null,
        });
        return [
          {
            type: 'notice',
            message:
              'An MCP server asked for input geniro cannot show yet, so the request was declined.',
          },
        ];
      }
      this.session.write(
        encodeError(
          id,
          JSONRPC_METHOD_NOT_FOUND,
          `geniro does not handle ${method}`,
        ),
      );
      return [];
    }
    if (
      method === CODEX_SERVER_REQUESTS.fileChangeApproval &&
      this.options.policy.autoAcceptFileChanges &&
      fileChangeStaysIn(params, this.session.items, this.input.cwd)
    ) {
      this.session.reply(id, encodeCodexReply(method, params, true, params));
      return [];
    }
    const encodedId = encodeRequestId(id);
    this.session.parked.set(encodedId, { method, params });
    return [
      {
        type: 'approval_request',
        id: encodedId,
        toolName: card.toolName,
        input: card.input,
        ...(card.question ? { requiresUserInteraction: true } : {}),
        ...(card.questions && card.questions.length > 0
          ? { questions: card.questions }
          : {}),
      },
    ];
  }

  /**
   * The reply for a verdict on a parked request, or undefined when nothing
   * here is parked under that id — a request the user answered twice, or one
   * this session never raised.
   */
  buildApprovalResponse(
    encodedId: string,
    allow: boolean,
    updatedInput?: unknown,
  ): string | undefined {
    const parked = this.session.parked.get(encodedId);
    const id = decodeRequestId(encodedId);
    if (parked === undefined || id === null) {
      return undefined;
    }
    this.session.parked.delete(encodedId);
    return encodeResult(
      id,
      encodeCodexReply(parked.method, parked.params, allow, updatedInput),
    );
  }

  // ── Mid-turn ──────────────────────────────────────────────────────────────

  /**
   * Hand the running turn another user message — `turn/steer`, which JOINS
   * the turn rather than replacing its prompt: codex folds the input in at its
   * next step and answers it before the turn completes.
   *
   * False until the turn's id is known, since the frame must name it; the
   * caller then keeps the message queued, which is always safe.
   */
  sendFollowUp(message: FollowUpMessage): boolean {
    const threadId = this.session.threadId;
    if (threadId === null || this.turnId === null || this.settled) {
      return false;
    }
    return this.session.request(
      CODEX_METHODS.turnSteer,
      {
        threadId,
        input: codexUserInput(message.text, message.images),
        expectedTurnId: this.turnId,
      },
      'turn_steer',
      [],
      firstLine(message.text, CODEX_STEER_PREVIEW_MAX_CHARS),
    );
  }

  /**
   * `turn/interrupt` for the running turn, or undefined before codex has named
   * it — the caller then falls back to ending the process group.
   */
  buildInterruptPayload(): string | undefined {
    const threadId = this.session.threadId;
    if (threadId === null || this.turnId === null || this.settled) {
      return undefined;
    }
    return this.session.frame(
      CODEX_METHODS.turnInterrupt,
      { threadId, turnId: this.turnId },
      'turn_interrupt',
    );
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  onNotification(method: string, params: unknown): AgentEvent[] {
    const record = asRecord(params) ?? {};
    const threadId = asString(record.threadId);
    if (threadId !== null && threadId !== this.session.threadId) {
      // Any other thread on this connection is one this conversation started
      // — a sub-agent, or a sub-agent's own — so what it spends is this
      // conversation's spend, whether or not its launch was seen.
      if (method === CODEX_NOTIFICATIONS.tokenUsageUpdated) {
        return this.onSubagentUsage(threadId, readTokenUsage(record));
      }
      return this.onSubagentNotification(threadId, method, record);
    }
    switch (method) {
      case CODEX_NOTIFICATIONS.threadStarted: {
        // A sub-agent's thread announces itself with the model it runs on,
        // which is what its spend is priced at.
        const thread = asRecord(record.thread);
        const id = asString(thread?.id);
        const model = asString(thread?.model);
        if (id !== null && id !== this.session.threadId && model) {
          this.session.subagentSpend.noteModel(id, model);
        }
        return [];
      }
      case CODEX_NOTIFICATIONS.turnStarted: {
        const id = asString(asRecord(record.turn)?.id);
        if (id !== null && this.turnId === null) {
          this.turnId = id;
        }
        return [];
      }
      case CODEX_NOTIFICATIONS.agentMessageDelta: {
        const delta = asString(record.delta);
        return delta ? [{ type: 'text_delta', text: delta }] : [];
      }
      case CODEX_NOTIFICATIONS.reasoningSummaryDelta:
      case CODEX_NOTIFICATIONS.reasoningTextDelta: {
        const delta = asString(record.delta);
        return delta ? [{ type: 'reasoning_delta', text: delta }] : [];
      }
      case CODEX_NOTIFICATIONS.itemStarted:
        return this.onItemStarted(readCodexItem(record.item));
      case CODEX_NOTIFICATIONS.itemCompleted:
        return this.onItemCompleted(readCodexItem(record.item));
      case CODEX_NOTIFICATIONS.planUpdated:
        return this.onPlanUpdated(record);
      case CODEX_NOTIFICATIONS.tokenUsageUpdated:
        return this.onTokenUsage(readTokenUsage(record));
      case CODEX_NOTIFICATIONS.error:
        return this.onError(record);
      case CODEX_NOTIFICATIONS.modelRerouted:
        return this.onModelRerouted(record);
      case CODEX_NOTIFICATIONS.turnCompleted:
        return this.onTurnCompleted(asRecord(record.turn));
      default:
        return [];
    }
  }

  private onItemStarted(item: CodexItem | null): AgentEvent[] {
    if (item === null) {
      return [];
    }
    this.session.items.set(item.id, item);
    if (item.type === 'contextCompaction') {
      this.compactingFrom = this.session.lastUsage?.last.totalTokens ?? null;
      return [
        {
          type: 'context_compacted',
          phase: 'started',
          trigger: this.compacts ? 'manual' : 'auto',
          preTokens: this.compactingFrom,
          postTokens: null,
        },
      ];
    }
    const events = itemStartedEvents(item);
    events.push(...this.trackSubAgentActivity(item));
    if (spawnsSubagent(item)) {
      const prompt = asString(item.record.prompt);
      events.push(
        subagentState(item.id, {
          label: prompt
            ? firstLine(prompt, CODEX_DELEGATE_LABEL_MAX_CHARS)
            : null,
          prompt,
          model: asString(item.record.model),
        }),
      );
    }
    return events;
  }

  private onItemCompleted(item: CodexItem | null): AgentEvent[] {
    if (item === null) {
      return [];
    }
    this.session.items.delete(item.id);
    if (item.type === 'contextCompaction') {
      const after = this.session.lastUsage?.last.totalTokens ?? null;
      return [
        {
          type: 'context_compacted',
          phase: 'finished',
          trigger: this.compacts ? 'manual' : 'auto',
          preTokens: this.compactingFrom,
          postTokens: after,
        },
      ];
    }
    if (item.type === 'agentMessage') {
      const text = asString(item.record.text);
      if (text) {
        this.finalText = text;
      }
    }
    const events = itemCompletedEvents(item);
    if (item.type === 'collabAgentToolCall') {
      events.push(...this.trackSubagents(item));
    }
    return events;
  }

  /**
   * What a collab call says about the sub-agents it concerns: a spawn names
   * the threads it opened, and every collab call reports which of them have
   * finished.
   */
  private trackSubagents(item: CodexItem): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (spawnsSubagent(item)) {
      for (const threadId of receiverThreadsOf(item)) {
        this.session.subagents.set(threadId, item.id);
      }
      if (receiverThreadsOf(item).length > 0) {
        this.session.openSubagent(item.id);
        events.push(subagentState(item.id, { open: true }));
      }
    }
    for (const { threadId, outcome } of finishedAgentsOf(item)) {
      events.push(...this.session.closeSubagent(threadId, outcome));
    }
    return events;
  }

  /**
   * What a `subAgentActivity` says: a launch opens the delegate — in the
   * background, since the parent's turn goes on (and may end) without it — and
   * any later activity naming an ending closes it. Read at the item's START,
   * the only moment it is reported: codex completes these items in the same
   * millisecond.
   */
  private trackSubAgentActivity(item: CodexItem): AgentEvent[] {
    const activity = subAgentActivityOf(item);
    if (activity === null) {
      return [];
    }
    if (activity.kind === 'started') {
      this.session.subagents.set(activity.threadId, item.id);
      this.session.openSubagent(item.id);
      return [subagentState(item.id, { open: true, label: activity.name })];
    }
    const outcome = subagentOutcomeOf(activity.kind);
    return outcome === null
      ? []
      : this.session.closeSubagent(activity.threadId, outcome);
  }

  /**
   * A notification about a thread that is not this conversation's own — one of
   * its sub-agents. Their items nest under the spawning call; their turn ending
   * closes the delegate. Everything else about them (deltas, their own token
   * counts) is left out: it is not the conversation the user is reading.
   */
  private onSubagentNotification(
    threadId: string,
    method: string,
    record: Record<string, unknown>,
  ): AgentEvent[] {
    const parent = this.session.subagents.get(threadId);
    if (parent === undefined) {
      return [];
    }
    const origin = { parentToolUseId: parent };
    switch (method) {
      case CODEX_NOTIFICATIONS.itemStarted: {
        const item = readCodexItem(record.item);
        if (item === null) {
          return [];
        }
        this.session.items.set(item.id, item);
        return itemStartedEvents(item).map((event) => ({
          ...event,
          ...origin,
        }));
      }
      case CODEX_NOTIFICATIONS.itemCompleted: {
        const item = readCodexItem(record.item);
        if (item === null) {
          return [];
        }
        this.session.items.delete(item.id);
        return itemCompletedEvents(item).map((event) => ({
          ...event,
          ...origin,
        }));
      }
      case CODEX_NOTIFICATIONS.turnCompleted: {
        const status = asString(asRecord(record.turn)?.status);
        return this.session.closeSubagent(
          threadId,
          subagentOutcomeOf(status) ?? 'failed',
        );
      }
      default:
        return [];
    }
  }

  private onPlanUpdated(record: Record<string, unknown>): AgentEvent[] {
    const tasks: AgentTask[] = asArray(record.plan).flatMap((entry, index) => {
      const step = asRecord(entry);
      const title = step ? asString(step.step) : null;
      if (!title) {
        return [];
      }
      return [
        {
          id: String(index + 1),
          title,
          status: PLAN_STATUS[asString(step?.status) ?? ''] ?? null,
          activeForm: null,
        },
      ];
    });
    // codex re-sends its whole plan every time it changes one step, so each
    // update is a snapshot, never a patch.
    return tasks.length > 0
      ? [{ type: 'task_list', mode: 'snapshot', tasks, toolCallId: null }]
      : [];
  }

  /**
   * One reading of this conversation's own thread: the window's size (a
   * LEVEL), what the requests since the last reading spent (an INCREMENT, the
   * live twin of the turn's own usage), and the turn's running cost.
   */
  private onTokenUsage(usage: CodexTokenUsage | null): AgentEvent[] {
    if (usage === null) {
      return [];
    }
    if (this.baseline === null) {
      this.baseline = baselineOf(usage);
    }
    const previous = this.previousTotal ?? this.baseline;
    this.previousTotal = usage.total;
    this.session.lastUsage = usage;
    this.session.noteFacts({ usage });
    const events: AgentEvent[] = [];
    const context = usage.last.totalTokens;
    if (context > 0) {
      events.push({
        type: 'context_progress',
        contextTokens: context,
        contextWindowTokens: usage.modelContextWindow,
        contextModel:
          usage.modelContextWindow !== null ? this.session.threadModel : null,
      });
    }
    events.push(...this.spendEvents(spendBetween(usage, previous, null)));
    return events;
  }

  /**
   * One reading of a SUB-AGENT's thread. Its spend is held on the session and
   * folded into the next ending of a turn of this conversation; meanwhile it
   * rides the live plane like the parent's own.
   */
  private onSubagentUsage(
    threadId: string,
    usage: CodexTokenUsage | null,
  ): AgentEvent[] {
    if (usage === null) {
      return [];
    }
    const { previous } = this.session.subagentSpend.record(threadId, usage);
    return this.spendEvents(spendBetween(usage, previous, null));
  }

  /**
   * The live plane's two spend events for what just landed: the tokens it
   * added, and the running cost of everything not yet on a durable row — this
   * turn's own requests (until it settles) plus every sub-agent's unbilled
   * spend. The cost is a LEVEL the consumer replaces; it is published only
   * when it can be priced.
   */
  private spendEvents(added: CodexSpend): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (
      added.inputTokens > 0 ||
      added.outputTokens > 0 ||
      added.cachedInputTokens > 0 ||
      added.cacheWriteInputTokens > 0
    ) {
      events.push({
        type: 'usage_progress',
        inputTokens: added.inputTokens,
        outputTokens: added.outputTokens,
        cacheReadTokens: added.cachedInputTokens,
        cacheCreationTokens: added.cacheWriteInputTokens,
      });
    }
    const cost = this.runningCost();
    if (cost !== null) {
      if (cost > 0) {
        this.session.liveCostReported = true;
      }
      events.push({ type: 'cost_progress', costUsd: cost });
    }
    return events;
  }

  /** What this turn's own requests have spent so far, or null before any. */
  private ownSpend(): CodexSpend | null {
    const latest = this.session.lastUsage;
    return latest === null || this.baseline === null
      ? null
      : spendBetween(
          latest,
          this.baseline,
          this.session.listPriceOf(this.session.threadModel),
        );
  }

  /** The sub-agents' spend no turn has recorded yet. */
  private subagentSpend(): CodexSpend | null {
    return this.session.subagentSpend.unbilled(
      (model) => this.session.listPriceOf(model),
      this.session.threadModel,
    );
  }

  /** Everything spent and not yet on a row, in dollars — null when unpriceable. */
  private runningCost(): number | null {
    const parts = [this.settled ? null : this.ownSpend(), this.subagentSpend()];
    return (
      sumSpends(parts.filter((part): part is CodexSpend => part !== null))
        ?.costUsd ?? null
    );
  }

  /**
   * This turn's usage for its terminal event — its own requests plus every
   * sub-agent's unbilled spend, which is then marked billed so the next turn
   * does not carry it again. Null when nothing at all was measured, so an
   * ending with no reading carries no usage rather than an empty one.
   */
  private settleUsage(durationMs: number | null): AgentUsage | null {
    const subagents = this.subagentSpend();
    if (this.baseline === null && subagents === null) {
      return null;
    }
    this.session.subagentSpend.markBilled();
    return turnUsageOf({
      latest: this.session.lastUsage,
      baseline: this.baseline,
      model: this.session.threadModel,
      durationMs,
      price: this.session.listPriceOf(this.session.threadModel),
      subagents,
    });
  }

  /**
   * The zero a turn owes the live plane before its terminal event, when it
   * published a running cost — see `CodexSession.liveCostReported`.
   */
  private retireLiveCost(): AgentEvent[] {
    if (!this.session.liveCostReported) {
      return [];
    }
    this.session.liveCostReported = false;
    return [{ type: 'cost_progress', costUsd: 0 }];
  }

  private onError(record: Record<string, unknown>): AgentEvent[] {
    const message =
      asString(asRecord(record.error)?.message) ?? 'codex reported an error';
    if (record.willRetry === true) {
      return [
        {
          type: 'notice',
          severity: 'warning',
          message: `codex: ${message} — retrying`,
        },
      ];
    }
    this.pendingError = message;
    return [];
  }

  private onModelRerouted(record: Record<string, unknown>): AgentEvent[] {
    const to = asString(record.toModel);
    if (!to) {
      return [];
    }
    const from = asString(record.fromModel);
    const reason = asString(record.reason);
    this.session.threadModel = to;
    this.session.noteFacts({ model: to });
    return [
      {
        type: 'notice',
        severity: 'info',
        message: `codex ran this turn on ${to}${from ? ` instead of ${from}` : ''}${reason ? ` (${reason})` : ''}.`,
      },
      { type: 'turn_model', model: to },
    ];
  }

  private onTurnCompleted(turn: Record<string, unknown> | null): AgentEvent[] {
    const id = asString(turn?.id);
    if (this.settled || (this.turnId !== null && id !== this.turnId)) {
      return [];
    }
    this.settled = true;
    const status = asString(turn?.status);
    // Every ending carries what the turn spent: a stopped or failed codex turn
    // has done its requests all the same, and its usage — its own and its
    // sub-agents' — is recorded nowhere else (measured: a cancelled turn on
    // chat 00ffe314 had spent $0.48 that no row carried). The live figure is
    // zeroed FIRST, because from the next event on that money is durable.
    const usage = this.settleUsage(asNumber(turn?.durationMs));
    const events = this.retireLiveCost();
    if (status === 'interrupted') {
      events.push({
        type: 'turn_cancelled',
        ...(usage === null ? {} : { usage }),
      });
      return events;
    }
    if (status === 'failed') {
      const message =
        asString(asRecord(turn?.error)?.message) ??
        this.pendingError ??
        'codex: the turn failed';
      events.push({
        type: 'error',
        message,
        ...(usage === null ? {} : { usage }),
      });
      return events;
    }
    events.push({
      type: 'turn_complete',
      usage:
        usage ??
        turnUsageOf({
          latest: this.session.lastUsage,
          baseline: this.baseline,
          model: this.session.threadModel,
          durationMs: asNumber(turn?.durationMs),
          price: this.session.listPriceOf(this.session.threadModel),
        }),
      stopReason: status ?? 'completed',
      finalText: this.finalText,
    });
    return events;
  }
}
