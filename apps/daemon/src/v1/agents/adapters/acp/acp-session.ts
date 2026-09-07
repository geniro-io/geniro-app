import type {
  AgentEvent,
  AgentTurnInput,
  FollowUpMessage,
  TurnDriver,
  TurnIo,
} from '../adapter.types';
import {
  ACP_AGENT_METHODS,
  ACP_PROTOCOL_VERSION,
  type AcpAgentCapabilities,
  type AcpMcpServerHttp,
  type AcpPermissionOption,
} from './acp.types';
import {
  type AcpSessionOptions,
  AcpTurnDriver,
  type PendingKind,
} from './acp-driver';
import {
  classifyMessage,
  encodeRequest,
  encodeResult,
  type JsonRpcId,
} from './acp-jsonrpc';

/**
 * How long each kind of frame's reply is waited for.
 *
 * PARTIAL on purpose, and the ABSENCES carry the reasoning. `prompt` is the
 * turn itself, so bounding it would give up on an agent that is working —
 * that is what `spawn-cli.ts`'s turn deadline already answers, measured
 * against SILENCE rather than against length. `initialize` / `session` /
 * `session_load` are the handshake: a reply that never comes leaves nothing to
 * run the turn on, so expiring one would emit a notice and change nothing.
 *
 * What is left is the one kind that can HOLD a prompt
 * (`AcpModelParameter.applyBeforePrompt`), where a reply that never arrives
 * strands a prompt that was never sent — silently, a held turn emitting nothing
 * at all, until the turn-level silence deadline gives up on it half an hour
 * later. Expiring turns that into a notice plus a turn running on the agent's
 * own settings, which is what a REFUSAL of the same frame already produces.
 *
 * `set_mode` and `set_model` are absent for the reason the handshake frames
 * are: neither is ever added to `promptBlockers`, so neither can strand
 * anything, and arming them would only buy a chance to narrate a turn that had
 * already run on. Being listed here is not on its own permission to speak —
 * every parameter travels under this one kind and most of them do not block
 * either, so `AcpTurnDriver.onRequestDeadline` re-checks before it emits.
 */
const REQUEST_DEADLINE_MS: Partial<Record<PendingKind, number>> = {
  set_model_parameter: 30_000,
};

/**
 * ONE `cursor-agent acp`-style process, and the turns run on it.
 *
 * This is the `TurnDriver` an ACP adapter returns, and it is the SESSION half
 * of what used to be one class: the transport, the JSON-RPC request-id counter
 * and its pending map, the capabilities the agent negotiated, the session id,
 * the MCP servers that session registered, and the model it is running as. One
 * per process; a fresh {@link AcpTurnDriver} is built for each turn.
 *
 * **The split is what makes a kept process safe.** ACP allows many
 * `session/prompt` calls on one session (spec: "Once a prompt turn completes,
 * the Client may send another `session/prompt` to continue the conversation"),
 * and it was measured here — two prompts on one live cursor-agent process, the
 * second answering a codeword only the first had been told. What stood in the
 * way was not the protocol but this client: nearly every field of the old class
 * was per-TURN and said so in its own doc comments, harmless only while a
 * session was exactly one turn. `imageBlocks` and the turn's `input` were the
 * sharpest — both fixed at construction, so a second turn would have re-sent
 * the first turn's attachments and, worse, its prompt.
 *
 * Resetting ~20 fields between turns was the alternative, and it is the shape
 * this deliberately avoids: it makes "remember to reset" the invariant, and the
 * next field added breaks it in silence. Here a field is per-turn by DEFAULT —
 * it lives on the object that is thrown away — and surviving a turn is a
 * deliberate move to this class.
 */
export class AcpSession implements TurnDriver {
  /**
   * The child's stdin/stdout for this PROCESS.
   *
   * Re-set on every turn rather than captured once: `spawn-cli` hands a fresh
   * `TurnIo` per turn (its `emit` routes to the turn currently open), so a
   * captured one would publish turn 2's events into turn 1's settled stream.
   */
  io: TurnIo | null = null;
  /**
   * What the agent said it can do, from the one `initialize` handshake. A
   * property of the process — nothing later restates it.
   */
  capabilities: AcpAgentCapabilities = {
    loadSession: false,
    mcpHttp: false,
    promptImage: false,
  };
  /** The conversation every turn on this process prompts into. */
  sessionId: string | null = null;
  /**
   * The MCP servers this SESSION registered. `composePrompt` derives the
   * call-surface grant from this rather than from a separate flag, so the "May
   * call" block and the tools it names cannot disagree — and it is session-wide
   * because `mcpServers` rides `session/new`, which happens once.
   */
  grantedMcpServers: AcpMcpServerHttp[] = [];
  /** This session was opened via `session/load` — and that load succeeded. */
  resumed = false;
  /**
   * The model the SESSION is running as, as the AGENT stated it — read from the
   * session reply's `models.currentModelId`, and replaced by the id the agent
   * CONFIRMS on a `set_model` reply. Never by the id a turn merely requested:
   * `turn_model` announces that one, and `PartialStreamService.rememberWindow`'s
   * anti-poisoning guard compares the two, so collapsing them onto this field
   * would leave it comparing a value against itself.
   *
   * Session-scoped because that is what it describes: ACP carries no model
   * announcement of its own, so this is the only thing a `turn_model` event can
   * be built from, and the fact it reports does not end with a turn.
   */
  currentModelId: string | null = null;
  /**
   * The `session/new` | `session/load` reply, verbatim.
   *
   * Kept because it is the ONLY statement of what this agent offers — its
   * modes, its models, and each model's config options with their current
   * values — and no later frame restates any of it. A second turn re-applying
   * its own mode and parameters reads them from here; without it a kept process
   * could only ever re-send blind, or skip the re-application and run every
   * later message under the first turn's settings.
   */
  lastSessionReply: Record<string, unknown> | null = null;
  /**
   * A prompt on this session has already carried geniro's host preamble.
   *
   * Prompt text is part of the CONVERSATION on this transport — there is no
   * out-of-band system-instruction field — so every block a turn prepends is
   * replayed to every turn after it. Re-sending the ~1.1KB preamble each time
   * put roughly 40 copies (~11k tokens) inside a 40-message thread's own
   * window, which is the same window the app's context readout reports on.
   *
   * `AcpTurnDriver.composePrompt` used to answer this with `resumed` alone, and
   * that was complete only while one process served one turn: every later turn
   * was a fresh process that `session/load`ed. With the process kept, a second
   * turn is neither resumed nor first, so without this flag the fix would have
   * quietly stopped working for the case it was written for.
   *
   * Only the preamble. The call-surface block still rides every turn, because
   * it is true only while those tools are registered THIS turn.
   */
  preambleSent = false;
  /**
   * The mode the session started in — the agent's own default, from the
   * session reply's `modes.currentModeId`.
   *
   * Kept because a mode is SESSION state that the client sets and nothing
   * resets: a turn that wants no particular mode has to name this to get back
   * to it. See {@link currentModeId}.
   */
  defaultModeId: string | null = null;
  /**
   * The mode the session is in NOW — {@link defaultModeId} until a turn's
   * `session/set_mode` is accepted, or until the AGENT moves itself and says so
   * on a `current_mode_update`, which is the only channel reporting a change
   * this client did not ask for.
   *
   * The pair exists because a mode outlives the turn that set it, which one
   * process per turn hid completely: a chat run under `plan` and then switched
   * back to `auto` sent nothing on its next turn (there being no mode to ask
   * for) and the agent stayed in plan mode, with the composer chip and the run
   * row both reading `auto`. That is the permission surface reading a posture
   * the CLI was never returned to.
   */
  currentModeId: string | null = null;

  // ── Keyed by a PROTOCOL id, which is the session's namespace ─────────────
  // Every map below is keyed by an ACP `toolCallId` or an encoded JSON-RPC
  // request id. Both are unique across the session and neither is re-minted
  // per turn, so a turn is the wrong scope for them — a fact hidden while a
  // session was one turn, and load-bearing now that a request raised in one
  // turn can be answered in the next (`spawn-cli` re-holds an unanswered
  // approval for the turn that follows).

  /** Tool name by ACP toolCallId, so a later update can name its result. */
  readonly toolNames = new Map<string, string>();
  /**
   * Tool kind by ACP toolCallId. `session/request_permission` may carry a
   * toolCall stub without one, and kind is what `acceptEdits` decides on — so
   * the kind announced on the original `tool_call` update has to survive.
   */
  readonly toolKinds = new Map<string, string>();
  /**
   * Tool arguments by ACP toolCallId. Same stub problem: a permission request
   * that omits the name and kind usually omits these too, and an approval card
   * showing no arguments asks the user to approve something they cannot see.
   */
  readonly toolInputs = new Map<string, unknown>();
  /**
   * Options offered per parked permission request, keyed by encoded id.
   *
   * SESSION-scoped, and that is a fix rather than a tidy-up. A request the user
   * has not answered when its turn settles is re-held and re-offered to the
   * NEXT turn (`spawn-cli`'s `pendingApprovals`), so the verdict arrives while
   * a different turn is current — and a per-turn map would then have no entry
   * for it, `buildApprovalResponse` would answer undefined, and the card would
   * read as answered while the agent stayed parked forever. Unreachable while
   * one process served one turn, because the session died with the turn.
   */
  readonly parkedPermissions = new Map<string, AcpPermissionOption[]>();
  /**
   * Params of each parked QUESTION, keyed by encoded id. A separate map from
   * the permissions above, and not merely for the payload: which map an id is
   * in is what picks the reply encoder, so a question can never be answered
   * with a permission outcome the agent would reject.
   */
  readonly parkedQuestions = new Map<string, unknown>();
  /**
   * Tool calls recognised as sub-agent launches, so their result can be treated
   * as the CLI's accounting rather than the delegate's answer (see
   * `AcpDelegateProtocol.resultIsBookkeeping`).
   */
  readonly delegateToolCalls = new Set<string>();
  /** Of those, the ones the CLI said keep running past their launching call. */
  readonly backgroundDelegates = new Set<string>();

  private nextRequestId = 1;
  /**
   * Frames awaiting a reply, and WHICH turn sent each.
   *
   * The turn is recorded rather than assumed, because a session outlives its
   * turns: a reply to a frame turn 1 sent can in principle arrive after turn 2
   * has opened, and handing it to turn 2 would apply turn 1's answer — a
   * refused model, a released prompt hold — to the wrong conversation. Such a
   * reply is dropped with a log instead.
   */
  private readonly pending = new Map<
    JsonRpcId,
    { kind: PendingKind; turn: AcpTurnDriver }
  >();
  /**
   * The deadline timers {@link armDeadline} started, keyed like
   * {@link pending} — a separate map because only some kinds carry one.
   */
  private readonly deadlines = new Map<JsonRpcId, NodeJS.Timeout>();
  /** The turn running right now. Replaced wholesale by {@link openTurn}. */
  private turn: AcpTurnDriver;

  constructor(
    readonly options: AcpSessionOptions,
    firstTurn: AgentTurnInput,
  ) {
    this.turn = new AcpTurnDriver(this, options.turnOptions(firstTurn));
  }

  /**
   * The FIRST turn's opening: wire stdin and start the handshake the agent
   * expects the client to begin (`initialize` → `session/new` | `session/load`).
   *
   * Only ever called for the first turn (`AgentAdapter.startTurn` gates it), and
   * that is right by construction — a handshake belongs to the PROCESS. Later
   * turns arrive through {@link openTurn}.
   */
  onStdinReady(io: TurnIo): void {
    this.io = io;
    const events: AgentEvent[] = [];
    this.request(
      ACP_AGENT_METHODS.initialize,
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          // Spread rather than assigned, so an adapter that declares nothing
          // sends no `_meta` key at all — an empty object is a claim too.
          ...(this.options.clientMeta
            ? { _meta: this.options.clientMeta }
            : {}),
        },
        clientInfo: {
          name: this.options.clientName,
          version: this.options.clientVersion,
        },
      },
      'initialize',
      events,
    );
    for (const event of events) {
      io.emit(event);
    }
  }

  /**
   * Open a SECOND (or later) turn on this live session —
   * `TurnDriver.openTurn`.
   *
   * A fresh {@link AcpTurnDriver} built from THIS turn's input, then that
   * turn's own mode, model, parameters and prompt. Nothing of the previous turn
   * comes with it, which is the whole reason the driver is per-turn.
   *
   * TOTAL by construction. The one thing here that can throw is reading this
   * turn's attachments off disk, and it is called from inside `spawn-cli`'s
   * `startTurn` — where a throw would unwind past a turn already registered as
   * current, wedging the session. An `error` event settles the turn instead,
   * which is the same outcome the first turn gets for an unreadable attachment
   * and says the same thing to the user.
   */
  openTurn(io: TurnIo, input: AgentTurnInput): void {
    this.io = io;
    let events: AgentEvent[];
    try {
      this.turn = new AcpTurnDriver(this, this.options.turnOptions(input));
      events = this.turn.openOnLiveSession();
    } catch (err) {
      events = [
        {
          type: 'error',
          message: `acp: could not open this turn: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ];
    }
    for (const event of events) {
      io.emit(event);
    }
  }

  onMessage(obj: unknown): AgentEvent[] {
    const message = classifyMessage(obj);
    switch (message.kind) {
      case 'response': {
        const pending = this.takePending(message.id);
        return pending === null
          ? []
          : pending.turn.onReply(pending.kind, message.result, message.id);
      }
      case 'error': {
        const pending = this.takePending(message.id);
        return pending === null
          ? []
          : pending.turn.onErrorReply(
              pending.kind,
              message.message,
              message.id,
            );
      }
      case 'request':
        return this.turn.onAgentRequest(
          message.id,
          message.method,
          message.params,
        );
      case 'notification':
        return this.turn.onNotification(message.method, message.params);
      case 'unknown':
        return [];
    }
  }

  buildApprovalResponse(
    id: string,
    allow: boolean,
    updatedInput?: unknown,
  ): string | undefined {
    return this.turn.buildApprovalResponse(id, allow, updatedInput);
  }

  sendFollowUp(message: FollowUpMessage): boolean {
    return this.turn.sendFollowUp(message);
  }

  buildInterruptPayload(): string | undefined {
    return this.turn.buildInterruptPayload();
  }

  // --- outbound -------------------------------------------------------------

  /** Send one request, answering whether it actually went out. */
  request(
    method: string,
    params: unknown,
    kind: PendingKind,
    events: AgentEvent[],
  ): boolean {
    return this.sendRequest(method, params, kind, events) !== null;
  }

  /**
   * {@link request}, answering with the id the frame went out under, or null
   * when it did not go out at all.
   *
   * The id is what correlates a reply with the frame that earned it, which only
   * the two frames whose reply changes a turn's own state need: a parameter the
   * prompt is held behind (`promptBlockers`) and the prompt itself
   * (`latestPromptId`).
   */
  sendRequest(
    method: string,
    params: unknown,
    kind: PendingKind,
    events: AgentEvent[],
  ): JsonRpcId | null {
    const id = this.nextRequestId++;
    this.pending.set(id, { kind, turn: this.turn });
    if (this.io?.write(encodeRequest(id, method, params)) !== true) {
      this.pending.delete(id);
      events.push({
        type: 'error',
        message: `acp: failed to send ${method}${this.writeFailure()}`,
      });
      return null;
    }
    // Only a frame that actually went out is waited for — the branch above
    // returns before this, so a write that failed arms nothing.
    this.armDeadline(id, kind);
    return id;
  }

  /**
   * Give up on one frame's reply once {@link REQUEST_DEADLINE_MS} has passed.
   *
   * `unref`ed, so a timer still armed can never hold the process open past the
   * work it belongs to. A kind the map does not name is waited for indefinitely,
   * exactly as before.
   */
  private armDeadline(id: JsonRpcId, kind: PendingKind): void {
    const ms = REQUEST_DEADLINE_MS[kind];
    if (ms === undefined) {
      return;
    }
    const timer = setTimeout(() => {
      // Dropped first, so the `takePending` below finds nothing left to clear.
      this.deadlines.delete(id);
      // Which also applies the stale-turn guard: a frame whose turn has since
      // ended is logged and dropped rather than narrated into the turn that
      // replaced it, on the same terms a late REPLY is.
      const entry = this.takePending(id);
      if (entry === null) {
        return;
      }
      for (const event of entry.turn.onRequestDeadline(id, entry.kind, ms)) {
        this.emit(event);
      }
    }, ms);
    timer.unref();
    this.deadlines.set(id, timer);
  }

  /** Answer one agent→client request. */
  reply(id: JsonRpcId, result: unknown): void {
    if (this.io?.write(encodeResult(id, result)) !== true) {
      this.options.logger?.warn(
        `acp: dropped a reply to request ${String(id)}${this.writeFailure()}`,
      );
    }
  }

  /** Write a frame this class did not build (an in-protocol error reply). */
  write(payload: string): boolean {
    return this.io?.write(payload) === true;
  }

  /** Publish one event outside a handler's own return — see `sendFollowUp`. */
  emit(event: AgentEvent): void {
    this.io?.emit(event);
  }

  /**
   * The " — <cause>" tail for a write that did not land, or `''` when the
   * writer named none.
   *
   * ASKED, never assumed. Every one of these sites used to assert `stdin is
   * closed`, which this client cannot know: `write` answers a bare boolean and
   * four different things produce that false (see `TurnIo.writeObstacle`). The
   * invented one named geniro as the closer, and it was wrong in the case that
   * mattered — cursor-agent closing its own read end while still running —
   * which sent a live investigation after the wrong process.
   */
  writeFailure(): string {
    const obstacle = this.io?.writeObstacle?.() ?? null;
    return obstacle === null ? '' : ` — ${obstacle}`;
  }

  /**
   * The pending entry for a reply, or null when nothing here is owed one.
   *
   * A reply owed to a turn that is no longer current is DROPPED rather than
   * given to the turn that is: see {@link pending}.
   */
  private takePending(
    id: JsonRpcId,
  ): { kind: PendingKind; turn: AcpTurnDriver } | null {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return null;
    }
    this.pending.delete(id);
    const timer = this.deadlines.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.deadlines.delete(id);
    }
    if (entry.turn !== this.turn) {
      this.options.logger?.warn(
        `acp: dropped the reply to request ${String(id)} (${entry.kind}) — the turn that sent it has already ended`,
      );
      return null;
    }
    return entry;
  }
}
