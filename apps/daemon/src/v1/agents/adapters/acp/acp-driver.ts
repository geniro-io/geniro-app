import { asArray, asNumber, asRecord, asString } from '../../utils/json-util';
import type {
  AgentEvent,
  AgentTurnInput,
  AgentUsage,
  TurnDriver,
  TurnIo,
} from '../adapter.types';
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_PROTOCOL_VERSION,
  ACP_STOP_REASONS,
  type AcpAgentCapabilities,
  type AcpContentBlock,
  type AcpImageBlock,
  type AcpMcpServerHttp,
  type AcpPermissionOption,
  type AcpPermissionOptionKind,
  type AcpStopReason,
  type AcpToolCall,
  type AcpUsageSnapshot,
} from './acp.types';
import { buildAcpImageBlocks } from './acp-content';
import {
  classifyMessage,
  decodeRequestId,
  encodeError,
  encodeRequest,
  encodeRequestId,
  encodeResult,
  JSONRPC_METHOD_NOT_FOUND,
  type JsonRpcId,
} from './acp-jsonrpc';
import {
  acpOffersModel,
  readAcpCurrentModelId,
  readAcpModelConfigId,
  readAcpModels,
} from './acp-models';

/** What we sent, so the reply can be routed without a callback map. */
type PendingKind =
  'initialize' | 'session' | 'set_mode' | 'set_model' | 'prompt';

/** A permission verdict this turn can reach without asking the user. */
export type AutoDecision = 'allow' | 'deny' | null;

/**
 * How ONE agent asks the USER an open-ended question over its own extension
 * method, since baseline ACP has no such call.
 *
 * Supplied by the adapter, never known here: this file is the agent-agnostic
 * protocol client, and the method name, the params shape and the reply shape
 * are all that CLI's own facts. What the driver owns is the LIFECYCLE — park
 * the JSON-RPC id, surface an `approval_request` the daemon's question seam
 * recognises, and answer with the encoder below when a verdict arrives. That
 * split is what lets a second agent's question channel be four values rather
 * than another branch in here.
 *
 * An adapter that declares none keeps the old behaviour: the request is
 * declined in-protocol with `-32601`, which is still the right answer for
 * every OTHER vendor extension.
 */
export interface AcpQuestionProtocol {
  /** The agent→client method that carries a question for the user. */
  method: string;
  /**
   * The name this question is surfaced under — the adapter's own
   * `questionToolName`, which is the ONE discriminator the daemon keys "render
   * a question card" and "never auto-answer this" on. Passing anything else
   * here would surface the question as an ordinary permission request.
   */
  toolName: string;
  /**
   * Whether these params READ as a question. False falls through to the
   * decline path, deliberately: this contract is documented rather than
   * observed live, so a shape that has drifted costs today's behaviour and
   * nothing more — never a turn parked on a card the user cannot answer.
   */
  accepts(params: unknown): boolean;
  /** The JSON-RPC result answering it, given the card's verdict. */
  encodeReply(params: unknown, allow: boolean, updatedInput: unknown): unknown;
}

export interface AcpDriverOptions {
  /** The turn being driven — prompt, cwd, resume id, MCP endpoint. */
  input: AgentTurnInput;
  /** Advertised to the agent as `clientInfo`. */
  clientName: string;
  clientVersion: string;
  /**
   * Resolve a permission request without the user. `null` surfaces an
   * `approval_request` event and parks the agent until a verdict arrives —
   * which is a capability the legacy `cursor-agent -p --force` path never had.
   */
  autoDecide: (toolCall: AcpToolCall) => AutoDecision;
  /** Session mode to request after the session exists, when the agent offers it. */
  preferredModeId?: string | null;
  /** How this agent asks the user a question, or absent when it cannot. */
  question?: AcpQuestionProtocol;
  /**
   * Agent→client methods this client refuses WITHOUT narrating it — the ones
   * whose own agent absorbs the refusal, so nothing about the turn changed.
   *
   * They are still declined in-protocol; what is withheld is only the
   * transcript notice, which is a per-turn budget of ONE. Spending it on a
   * refusal that cost nothing leaves a refusal that cost something unmentioned
   * later in the same turn.
   *
   * Membership must be EVIDENCE, not a guess: the entry belongs here only once
   * that agent's own handling of the refusal has been read or observed. An
   * unlisted method keeps the notice, which is the safe default.
   */
  declinedWithoutNotice?: readonly string[];
  /**
   * The turn's instruction text, given whether the call tools were registered.
   * Supplied by the adapter so the include-the-callee-block rule stays owned
   * by `AgentAdapter.composeSystemPrompt` rather than re-derived per protocol.
   */
  composeSystemPrompt: (granted: boolean) => string;
  logger?: { warn(message: string): void; debug?(message: string): void };
}

function textOf(content: unknown): string | null {
  const block = asRecord(content);
  if (!block || asString(block.type) !== 'text') {
    return null;
  }
  const text = asString(block.text);
  return text !== null && text.length > 0 ? text : null;
}

/**
 * An argument bag the agent sent but left EMPTY reads as null, because that is
 * what it means: the call was named and its arguments were not disclosed.
 *
 * `{}` is not a hypothetical. Probed on cursor-agent 2026.08.04-aaa8809 over
 * `cursor-agent acp`: a shell call carries real arguments
 * (`rawInput: {"command":"echo …"}`), while its `read`, `search` and `edit`
 * calls all send `rawInput: {}` on the initial `tool_call` and then send NO
 * `rawInput` on any later `tool_call_update` — so there is no fuller version
 * arriving behind it to wait for, and `locations` is never populated either.
 * Keeping the `{}` made every consumer state it as fact: the transcript row
 * rendered the arguments as `{}`, which is what the user reported.
 *
 * Normalized HERE rather than at each reader so the permission card and the
 * transcript row cannot disagree about whether arguments exist, and left
 * agent-agnostic because "sent an empty bag" is a protocol shape, not one
 * CLI's quirk — an ACP agent that discloses its arguments is unaffected.
 */
function disclosedInput(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  return record !== null && Object.keys(record).length === 0 ? null : value;
}

/**
 * The `diff` content blocks a tool call reports — ACP's own
 * `ToolCallContent` variant `{type:'diff', path, oldText, newText}`.
 *
 * This is the one place a cursor edit says WHAT IT DID: probed on cursor-agent
 * 2026.08.11-e8db854, its `edit` calls send `rawInput: {}` on the opening
 * `tool_call`, no `rawInput` ever after, no `locations` — and then the completing
 * `tool_call_update` carries the full diff, path included. Read here so the row
 * can render a diff and name the file instead of printing the raw block array as
 * JSON, which is what it did: `[{"type":"diff","path":"/private/tmp/…",
 * "oldText":"alpha\nbeta\n"…}]`, escaped newlines and all.
 *
 * `oldText` is nullable in the schema (a creation has no previous text) and is
 * normalized to null here, so a reader never has to tell `null` from absent.
 */
function readAcpDiffs(
  content: unknown,
): { path: string | null; oldText: string | null; newText: string }[] {
  const diffs: {
    path: string | null;
    oldText: string | null;
    newText: string;
  }[] = [];
  for (const entry of asArray(content)) {
    const block = asRecord(entry);
    if (!block || asString(block.type) !== 'diff') {
      continue;
    }
    const newText = asString(block.newText);
    if (newText === null) {
      // A diff with no new text is not renderable as one; let the caller fall
      // back to reporting the raw block rather than showing an empty panel.
      continue;
    }
    diffs.push({
      path: asString(block.path),
      oldText: asString(block.oldText),
      newText,
    });
  }
  return diffs;
}

function readToolCall(source: Record<string, unknown>): AcpToolCall {
  return {
    toolCallId: asString(source.toolCallId) ?? '',
    // `name` is the machine identifier; `title` is the human label every ACP
    // tool call carries. Prefer the former, fall back so the transcript row is
    // never blank.
    name: asString(source.name) ?? asString(source.title) ?? '',
    status: (asString(source.status) as AcpToolCall['status']) ?? null,
    kind: asString(source.kind),
    rawInput: disclosedInput(source.rawInput),
    rawOutput: source.rawOutput ?? null,
  };
}

function readPermissionOptions(value: unknown): AcpPermissionOption[] {
  const options: AcpPermissionOption[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    const optionId = record ? asString(record.optionId) : null;
    const kind = record ? asString(record.kind) : null;
    if (record && optionId !== null && kind !== null) {
      options.push({
        optionId,
        name: asString(record.name) ?? optionId,
        kind: kind as AcpPermissionOptionKind,
      });
    }
  }
  return options;
}

/**
 * Pick the option to answer a permission request with. Only `*_once` kinds are
 * eligible: selecting an `*_always` option would persist a decision beyond the
 * turn that the user was never asked to make at that scope. Returns null when
 * the agent offered nothing matching, which the caller reports as a `cancelled`
 * outcome rather than guessing.
 */
export function selectPermissionOption(
  options: AcpPermissionOption[],
  allow: boolean,
): string | null {
  const wanted: AcpPermissionOptionKind = allow ? 'allow_once' : 'reject_once';
  return options.find((option) => option.kind === wanted)?.optionId ?? null;
}

/**
 * Drives ONE ACP turn over the child's stdin/stdout: the client-initiated
 * handshake (`initialize` → `session/new` | `session/load` → optional
 * `session/set_mode` → `session/prompt`), then the agent's `session/update`
 * stream, its `session/request_permission` round-trips, and finally the
 * `session/prompt` reply carrying the stop reason that ends the turn.
 *
 * One instance per turn — it holds the request ids, the session id, the
 * accumulated usage, and the parked permission requests, none of which may be
 * shared across the N concurrent turns one adapter instance serves.
 *
 * Everything inbound is read through the defensive `json-util` accessors: an
 * unrecognized notification, an unparseable update, or a field that moved
 * between CLI versions degrades to "no event", never to a thrown turn.
 */
export class AcpTurnDriver implements TurnDriver {
  private io: TurnIo | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingKind>();
  private capabilities: AcpAgentCapabilities = {
    loadSession: false,
    mcpHttp: false,
    promptImage: false,
  };
  /**
   * The turn's attachments, read off disk at construction — inside
   * `AgentAdapter.start`'s synchronous try, so an unreadable file fails the
   * turn there instead of throwing out of the message pump mid-handshake.
   */
  private readonly imageBlocks: AcpImageBlock[];
  private sessionId: string | null = null;
  /**
   * `session/load` makes the agent REPLAY the whole prior conversation as
   * `session/update` notifications before it replies. Those are history we
   * already have in SQLite — persisting them again would duplicate every past
   * message into the transcript on each resumed turn — so transcript-producing
   * updates are dropped until the load reply lands.
   */
  private replaying = false;
  /**
   * Replay accounting for a resumed turn. `session/load` streams the whole
   * prior conversation back before the prompt can be sent, and nothing in the
   * protocol bounds that volume — so the cost is measured per turn rather than
   * assumed, which is what any decision to avoid `session/load` needs.
   */
  private replayStartedAt: number | null = null;
  private replayedUpdates = 0;
  /** Mode we asked for, so the reply can report an honest failure. */
  private requestedModeId: string | null = null;
  private readonly usage: AcpUsageSnapshot = {
    inputTokens: null,
    outputTokens: null,
    contextUsed: null,
    costAmount: null,
    costCurrency: null,
  };
  private readonly textChunks: string[] = [];
  /**
   * The assistant-text or thought block being streamed right now, not yet
   * written as a transcript row.
   *
   * ACP delivers a message as a run of `agent_message_chunk` notifications with
   * no "block complete" frame, so the driver has to decide where a row ends.
   * Emitting a durable `text` per chunk — which is what this did — wrote ONE
   * ROW PER WORD: a single short cursor reply landed as 68 `message` rows and
   * 68 socket emissions, and the transcript rendered as a column of one-word
   * paragraphs. The words still stream live (each chunk is a `text_delta`,
   * EPHEMERAL by the contract in `adapter.types.ts`); only the join becomes a
   * row, which is exactly how the claude adapter already behaves.
   *
   * `kind` is carried so a thought and an answer cannot merge into one row when
   * the agent switches between them mid-turn.
   */
  private pendingBlock: {
    kind: 'text' | 'reasoning';
    parts: string[];
  } | null = null;
  /** Tool name by ACP toolCallId, so a later update can name its result. */
  private readonly toolNames = new Map<string, string>();
  /**
   * Tool kind by ACP toolCallId. `session/request_permission` may carry a
   * toolCall stub without one, and kind is what `acceptEdits` decides on — so
   * the kind announced on the original `tool_call` update has to survive.
   */
  private readonly toolKinds = new Map<string, string>();
  /**
   * Tool arguments by ACP toolCallId. Same stub problem: a permission request
   * that omits the name and kind usually omits these too, and an approval card
   * showing no arguments asks the user to approve something they cannot see.
   */
  private readonly toolInputs = new Map<string, unknown>();
  /** Options offered per parked permission request, keyed by encoded id. */
  private readonly parkedPermissions = new Map<string, AcpPermissionOption[]>();
  /**
   * Params of each parked QUESTION, keyed by encoded id. A separate map from
   * the permissions above, and not merely for the payload: which map an id is
   * in is what picks the reply encoder, so a question can never be answered
   * with a permission outcome the agent would reject.
   */
  private readonly parkedQuestions = new Map<string, unknown>();
  /** One notice per turn for unimplemented agent→client requests. */
  private warnedUnsupportedRequest = false;
  /**
   * The MCP servers this turn actually registered. `composePrompt` derives the
   * call-surface grant from this rather than from a separate flag, so the
   * "May call" block and the tools it names cannot disagree.
   */
  private grantedMcpServers: AcpMcpServerHttp[] = [];
  /** This turn resumed via `session/load`, whose reply reports no modes. */
  private resumed = false;
  /** The model asked for, so a refusal can name it. */
  private requestedModelId: string | null = null;

  constructor(private readonly options: AcpDriverOptions) {
    this.imageBlocks = buildAcpImageBlocks(options.input.images);
  }

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

  onMessage(obj: unknown): AgentEvent[] {
    const message = classifyMessage(obj);
    switch (message.kind) {
      case 'response': {
        const kind = this.pending.get(message.id);
        if (kind === undefined) {
          return [];
        }
        this.pending.delete(message.id);
        return this.onReply(kind, message.result);
      }
      case 'error': {
        const kind = this.pending.get(message.id);
        if (kind === undefined) {
          return [];
        }
        this.pending.delete(message.id);
        return this.onErrorReply(kind, message.message);
      }
      case 'request':
        return this.onAgentRequest(message.id, message.method, message.params);
      case 'notification':
        return this.onNotification(message.method, message.params);
      case 'unknown':
        return [];
    }
  }

  /**
   * Encode a verdict for a parked agent request.
   *
   * For a `session/request_permission`, `updatedInput` is ignored: ACP's
   * permission outcome carries an option choice only, with no channel for a
   * modified tool input. For a parked QUESTION it is the whole payload — the
   * card's answer folded in by the adapter's `withAnswer` — and the adapter's
   * own encoder turns it into that agent's reply shape.
   */
  buildApprovalResponse(
    id: string,
    allow: boolean,
    updatedInput?: unknown,
  ): string | undefined {
    const requestId = decodeRequestId(id);
    if (this.parkedQuestions.has(id)) {
      const params = this.parkedQuestions.get(id);
      this.parkedQuestions.delete(id);
      const question = this.options.question;
      if (requestId === null || question === undefined) {
        return undefined;
      }
      return encodeResult(
        requestId,
        question.encodeReply(params, allow, updatedInput),
      );
    }
    const options = this.parkedPermissions.get(id);
    if (requestId === null || options === undefined) {
      return undefined;
    }
    this.parkedPermissions.delete(id);
    const optionId = selectPermissionOption(options, allow);
    return encodeResult(requestId, {
      outcome:
        optionId === null
          ? // The agent offered no `*_once` option in the direction we need.
            // `cancelled` is the only honest answer — it unparks the agent
            // without claiming a permission we cannot express.
            { outcome: 'cancelled' }
          : { outcome: 'selected', optionId },
    });
  }

  // --- outbound -----------------------------------------------------------

  private request(
    method: string,
    params: unknown,
    kind: PendingKind,
    events: AgentEvent[],
  ): void {
    const id = this.nextRequestId++;
    this.pending.set(id, kind);
    if (this.io?.write(encodeRequest(id, method, params)) !== true) {
      this.pending.delete(id);
      events.push({
        type: 'error',
        message: `acp: failed to send ${method} (the agent's stdin is closed)`,
      });
    }
  }

  private reply(id: JsonRpcId, result: unknown): void {
    if (this.io?.write(encodeResult(id, result)) !== true) {
      this.options.logger?.warn(
        `acp: dropped a reply to request ${String(id)} — stdin is closed`,
      );
    }
  }

  // --- inbound ------------------------------------------------------------

  private onReply(kind: PendingKind, result: unknown): AgentEvent[] {
    switch (kind) {
      case 'initialize':
        return this.onInitialized(result);
      case 'session':
        return this.onSessionReady(result);
      case 'set_mode':
        // A mode the agent accepted needs no announcement; a mode it rejected
        // arrives as an error reply instead (see onErrorReply).
        return [];
      case 'set_model':
        // Same contract as `set_mode` above.
        return [];
      case 'prompt':
        return this.onPromptComplete(result);
    }
  }

  private onErrorReply(kind: PendingKind, message: string): AgentEvent[] {
    if (kind === 'set_mode') {
      // A refused mode is a degrade, not a failure: the turn still runs, just
      // in the agent's default mode. Say so rather than silently downgrading.
      return [
        {
          type: 'notice',
          message: `agent declined session mode '${this.requestedModeId ?? ''}': ${message}`,
        },
      ];
    }
    if (kind === 'set_model') {
      // Same shape as a refused mode, and the same reason it cannot be silent:
      // the turn goes on, on a model the user did not pick. Reachable even
      // after the offers check, because the check reads what the agent listed
      // and the agent is free to refuse anyway.
      return [
        {
          type: 'notice',
          message: `agent declined model '${this.requestedModelId ?? ''}': ${message} — this turn runs on the agent's current model`,
        },
      ];
    }
    return [{ type: 'error', message: `acp ${kind} failed: ${message}` }];
  }

  private onInitialized(result: unknown): AgentEvent[] {
    const events: AgentEvent[] = [];
    const root = asRecord(result);
    const agentCapabilities = root ? asRecord(root.agentCapabilities) : null;
    const mcpCapabilities = agentCapabilities
      ? asRecord(agentCapabilities.mcpCapabilities)
      : null;
    const promptCapabilities = agentCapabilities
      ? asRecord(agentCapabilities.promptCapabilities)
      : null;
    this.capabilities = {
      loadSession: agentCapabilities?.loadSession === true,
      mcpHttp: mcpCapabilities?.http === true,
      promptImage: promptCapabilities?.image === true,
    };

    const version = root ? asNumber(root.protocolVersion) : null;
    if (version !== null && version !== ACP_PROTOCOL_VERSION) {
      // Best-effort: the agent named a version we don't implement. Keep going
      // (the methods we use are stable across v1) but leave a trace, because
      // this is the first thing to suspect if the turn behaves oddly.
      events.push({
        type: 'notice',
        message: `agent negotiated ACP protocol version ${version}; this client implements ${ACP_PROTOCOL_VERSION}`,
      });
    }

    const { mcpServers, notice } = this.buildMcpServers();
    this.grantedMcpServers = mcpServers;
    if (notice) {
      events.push({ type: 'notice', message: notice });
    }

    const resumeId = this.options.input.resumeSessionId?.trim();
    if (resumeId && this.capabilities.loadSession) {
      this.replaying = true;
      this.resumed = true;
      this.replayStartedAt = Date.now();
      this.request(
        ACP_AGENT_METHODS.sessionLoad,
        { sessionId: resumeId, cwd: this.options.input.cwd, mcpServers },
        'session',
        events,
      );
      return events;
    }
    if (resumeId) {
      // Resume was asked for and the agent cannot do it. The turn still runs,
      // but it starts a FRESH conversation — the user must see that their
      // thread's history is not in this turn's context.
      events.push({
        type: 'notice',
        message:
          'agent does not support session/load — this turn starts a fresh session instead of resuming',
      });
    }
    this.request(
      ACP_AGENT_METHODS.sessionNew,
      { cwd: this.options.input.cwd, mcpServers },
      'session',
      events,
    );
    return events;
  }

  /**
   * Build the client-supplied MCP server list. The call token rides an HTTP
   * header inside a stdin JSON-RPC frame — never argv (`ps`-visible) and never
   * a file on disk, which is what both legacy delivery mechanisms had to use.
   */
  private buildMcpServers(): {
    mcpServers: AcpMcpServerHttp[];
    notice: string | null;
  } {
    const endpoint = this.options.input.mcpEndpoint;
    if (!endpoint) {
      return { mcpServers: [], notice: null };
    }
    if (!this.capabilities.mcpHttp) {
      // The awareness block goes with the tools. Leaving it in would instruct
      // the agent to route work through `call_agent` with nothing registered
      // under that name — its callees never run and the turn still reports
      // success, which is exactly what the pre-ACP degrade path prevented.
      return {
        mcpServers: [],
        notice:
          'agent calls disabled for this turn: the agent does not advertise HTTP MCP support (mcpCapabilities.http), so the callee list was removed from this turn’s instructions too',
      };
    }
    return {
      mcpServers: [
        {
          type: 'http',
          name: endpoint.serverName,
          url: endpoint.url,
          headers: [
            { name: 'Authorization', value: `Bearer ${endpoint.token}` },
          ],
        },
      ],
      notice: null,
    };
  }

  private onSessionReady(result: unknown): AgentEvent[] {
    const events: AgentEvent[] = [];
    const root = asRecord(result);
    // `session/new` mints an id; `session/load` returns none, because the id is
    // the one we just sent.
    this.sessionId =
      (root ? asString(root.sessionId) : null) ??
      this.options.input.resumeSessionId?.trim() ??
      null;
    this.replaying = false;
    this.reportReplayCost();

    if (this.sessionId === null) {
      return [
        {
          type: 'error',
          message: 'acp session failed: the agent returned no session id',
        },
      ];
    }
    events.push({ type: 'session', sessionId: this.sessionId });

    const modeId = this.pickMode(root);
    if (modeId !== null) {
      this.requestedModeId = modeId;
      this.request(
        ACP_AGENT_METHODS.sessionSetMode,
        { sessionId: this.sessionId, modeId },
        'set_mode',
        events,
      );
    } else if (this.options.preferredModeId) {
      // The requested mode was NOT applied. Either way this turn runs under
      // the agent's current mode, which for a read-only request like `plan`
      // means write access the user believed they had turned off — so it can
      // never be silent. WHICH message is truthful depends on what we sent:
      // a `session/load` reply carries no `modes` block at all, so reading
      // that absence as "not offered" would state something false about the
      // agent on every resumed turn.
      events.push({
        type: 'notice',
        message: this.resumed
          ? `the '${this.options.preferredModeId}' mode could not be set on a resumed session — this turn runs under the agent's current mode`
          : `agent does not offer the '${this.options.preferredModeId}' mode — this turn runs under the agent's current mode instead`,
      });
    }

    this.applyModel(root, events);

    this.request(
      ACP_AGENT_METHODS.sessionPrompt,
      {
        sessionId: this.sessionId,
        prompt: this.composePromptBlocks(events),
      },
      'prompt',
      events,
    );
    return events;
  }

  /**
   * Put the turn on the model it asked for, before the prompt goes out.
   *
   * Sent rather than awaited, exactly as `session/set_mode` above is: the
   * frames leave on one ordered stdio stream, so the agent applies the model
   * before it reads the prompt. Waiting for the reply would cost a round-trip
   * on every turn to learn something the ordering already guarantees.
   *
   * A turn that names no model is left alone — the agent's own default is the
   * right answer, and forcing the id it just reported as current would spend a
   * frame to change nothing.
   */
  private applyModel(
    sessionResult: Record<string, unknown> | null,
    events: AgentEvent[],
  ): void {
    const wanted = this.options.input.model?.trim();
    if (!wanted || this.sessionId === null) {
      return;
    }
    if (readAcpCurrentModelId(sessionResult) === wanted) {
      return;
    }
    // The offers check applies only when the agent actually ENUMERATED a
    // vocabulary. It exists to save a round-trip to be refused, and that is
    // worth doing only against a reply that says what is on offer — silence is
    // not a refusal. `readAcpModels` states the contract this obeys: an empty
    // result means "the agent said nothing", never "the agent has no models",
    // and every caller must read it as unknown.
    //
    // Two replies are silent, and reading either as "not offered" would refuse
    // LOCALLY: a `session/load` reply is not observed to carry the block at all
    // — every turn after a chat's first resumes, since cursor cannot keep its
    // process, so the model would go unapplied for the whole conversation with
    // a degrade row per turn — and a `session/new` reply is free to omit it
    // too, which would assert something the agent never said. Sending it and
    // letting the agent answer is strictly better either way: `onErrorReply`
    // already turns a genuine refusal into the same notice, earned rather than
    // assumed. That subsumes the resumed case, so there is no branch on it.
    const offered = readAcpModels(sessionResult);
    if (offered.length > 0 && !acpOffersModel(sessionResult, wanted)) {
      // Never silent, for the reason the mode degrade above is not: a node the
      // user pointed at one model quietly running on another is a wrong turn
      // that reports success.
      events.push({
        type: 'notice',
        message: `agent does not offer the model '${wanted}' — this turn runs on the agent's current model instead`,
      });
      return;
    }
    this.requestedModelId = wanted;
    // ACP 1.0 replaced `session/set_model` with the general
    // `session/set_config_option`. Which one this agent gets is decided by
    // whether IT enumerated a model config option, not by its version string —
    // an agent that listed its models there implements the method that sets
    // them. Both replies route to the same `set_model` pending kind: the
    // operation the user asked for is "put this turn on that model", and the
    // degrade notice owes them that sentence whichever frame carried it.
    const configId = readAcpModelConfigId(sessionResult);
    if (configId !== null) {
      this.request(
        ACP_AGENT_METHODS.sessionSetConfigOption,
        { sessionId: this.sessionId, configId, value: wanted },
        'set_model',
        events,
      );
      return;
    }
    this.request(
      ACP_AGENT_METHODS.sessionSetModel,
      { sessionId: this.sessionId, modelId: wanted },
      'set_model',
      events,
    );
  }

  /**
   * The turn's `session/prompt` blocks: its attachments first, then its text —
   * the order the claude path sends, and the one that reads as "here is the
   * picture, here is what I'm asking about it".
   *
   * The images go ONLY to an agent that advertised `promptCapabilities.image`.
   * One that did not gets the text alone plus a `notice`, because the two
   * silent alternatives are both worse: sending anyway earns an error reply
   * that fails the whole turn over an attachment, and dropping them quietly
   * leaves the user watching the agent answer about a screenshot it never
   * received. This is the same class of gap as an unavailable session mode,
   * and it is reported the same way.
   */
  private composePromptBlocks(events: AgentEvent[]): AcpContentBlock[] {
    const text: AcpContentBlock = { type: 'text', text: this.composePrompt() };
    if (this.imageBlocks.length === 0) {
      return [text];
    }
    if (!this.capabilities.promptImage) {
      const count = this.imageBlocks.length;
      events.push({
        type: 'notice',
        message: `agent does not accept image prompts — ${count} attached image${count === 1 ? ' was' : 's were'} not sent with this turn`,
      });
      return [text];
    }
    return [...this.imageBlocks, text];
  }

  /**
   * Log what this turn's `session/load` replay actually cost. The prompt is
   * structurally blocked behind it, so this is per-turn latency that grows
   * with thread length — and the volume depends on the agent's own
   * implementation, which is why it is measured rather than extrapolated.
   */
  private reportReplayCost(): void {
    if (this.replayStartedAt === null) {
      return;
    }
    const elapsedMs = Date.now() - this.replayStartedAt;
    this.replayStartedAt = null;
    this.options.logger?.debug?.(
      `acp session/load replayed ${this.replayedUpdates} update(s) in ${elapsedMs}ms before this turn's prompt could be sent`,
    );
  }

  /**
   * ACP carries no system-prompt parameter, so the turn's instructions are
   * prepended to the prompt text. WHICH instructions is the base adapter's
   * rule, not this driver's — see `AgentAdapter.composeSystemPrompt`; this
   * only supplies whether the call tools ended up registered.
   */
  private composePrompt(): string {
    const instructions = this.options.composeSystemPrompt(
      this.grantedMcpServers.length > 0,
    );
    return [instructions, this.options.input.prompt]
      .filter((part) => part.length > 0)
      .join('\n\n');
  }

  /**
   * The preferred mode, but only when the agent actually offers it and is not
   * already in it. Asking for a mode that isn't in `availableModes` earns an
   * error reply, so check first rather than spend a round-trip to be refused.
   */
  private pickMode(
    sessionResult: Record<string, unknown> | null,
  ): string | null {
    const wanted = this.options.preferredModeId;
    if (!wanted) {
      return null;
    }
    const modes = sessionResult ? asRecord(sessionResult.modes) : null;
    if (!modes) {
      return null;
    }
    if (asString(modes.currentModeId) === wanted) {
      return null;
    }
    return this.offersMode(sessionResult, wanted) ? wanted : null;
  }

  /** Whether the session reply lists `modeId` among its available modes. */
  private offersMode(
    sessionResult: Record<string, unknown> | null,
    modeId: string,
  ): boolean {
    const modes = sessionResult ? asRecord(sessionResult.modes) : null;
    if (!modes) {
      return false;
    }
    if (asString(modes.currentModeId) === modeId) {
      return true;
    }
    return asArray(modes.availableModes).some((entry) => {
      const record = asRecord(entry);
      return record !== null && asString(record.id) === modeId;
    });
  }

  private onPromptComplete(result: unknown): AgentEvent[] {
    const root = asRecord(result);
    const rawStopReason = root ? asString(root.stopReason) : null;
    const stopReason = (ACP_STOP_REASONS as readonly string[]).includes(
      rawStopReason ?? '',
    )
      ? (rawStopReason as AcpStopReason)
      : null;

    if (stopReason === 'cancelled') {
      // A cancelled turn is not a completion — it must not record usage or a
      // final answer downstream nodes would then consume. What the user
      // ALREADY SAW is a different question: the open block is still written,
      // so cancelling does not erase the words that reached the screen.
      return [...this.flushPending(), { type: 'turn_cancelled' }];
    }

    const promptUsage = root ? asRecord(root.usage) : null;
    if (promptUsage) {
      this.usage.inputTokens = asNumber(promptUsage.inputTokens);
      this.usage.outputTokens = asNumber(promptUsage.outputTokens);
    }
    const text = this.textChunks.join('');
    return [
      // The turn is over, so the last block has no more chunks coming — this
      // is the ONLY close for a reply that ended without a tool call after it.
      ...this.flushPending(),
      {
        type: 'turn_complete',
        usage: this.buildUsage(),
        stopReason: rawStopReason,
        finalText: text.length > 0 ? text : null,
      },
    ];
  }

  /**
   * Close the open block as ONE durable event, or nothing when none is open.
   * Idempotent: a second call before the next chunk yields nothing.
   */
  private flushPending(): AgentEvent[] {
    const block = this.pendingBlock;
    this.pendingBlock = null;
    if (!block) {
      return [];
    }
    const text = block.parts.join('');
    if (text.length === 0) {
      return [];
    }
    return [
      block.kind === 'text'
        ? { type: 'text', text }
        : { type: 'reasoning', text },
    ];
  }

  /**
   * Add a chunk to the open block, closing a block of the OTHER kind first —
   * an agent that thinks, answers, then thinks again produces three rows, not
   * one merged blob.
   */
  private appendPending(
    kind: 'text' | 'reasoning',
    text: string,
  ): AgentEvent[] {
    const closed =
      this.pendingBlock !== null && this.pendingBlock.kind !== kind
        ? this.flushPending()
        : [];
    if (this.pendingBlock === null) {
      this.pendingBlock = { kind, parts: [] };
    }
    this.pendingBlock.parts.push(text);
    return closed;
  }

  private buildUsage(): AgentUsage {
    return {
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      // ACP reports context occupancy directly (`UsageUpdate.used`), so unlike
      // the claude adapter there are no cache counters to sum. Fall back to the
      // plain input count when the agent never sent a usage_update.
      contextTokens: this.usage.contextUsed ?? this.usage.inputTokens,
      // ACP never reports the model's window size — `UsageUpdate` carries only
      // occupancy — so the consumer shows the count with no denominator rather
      // than this client claiming a window no agent stated. With no window
      // there is nothing for a model id to describe either.
      contextWindowTokens: null,
      contextModel: null,
      // The field is `costUsd`: report an amount only when the agent priced the
      // turn in USD, rather than silently relabelling another currency.
      costUsd:
        this.usage.costCurrency?.toUpperCase() === 'USD'
          ? this.usage.costAmount
          : null,
    };
  }

  private onAgentRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): AgentEvent[] {
    if (method === ACP_CLIENT_METHODS.sessionRequestPermission) {
      return this.onPermissionRequest(id, params);
    }
    const question = this.options.question;
    if (question !== undefined && method === question.method) {
      // The agent is asking the USER something. Declining this one is not a
      // neutral refusal like the others below: an agent that has a fallback
      // takes it, and the fallback cannot carry a question — cursor's replays
      // each one as a bare permission request whose Approve silently means
      // "the first option" (measured; see CURSOR_ASK_QUESTION_METHOD). So the
      // cost of refusing is a fabricated answer, not a stall. Park it as a
      // card instead, where the user sees what they are choosing between.
      if (question.accepts(params)) {
        return this.onQuestionRequest(id, params, question);
      }
      // Params that do not read as a question fall through to the decline.
      // The shape is documented rather than probe-observed, and a card built
      // from a payload we could not parse is worse than the refusal.
      this.options.logger?.warn(
        `acp: ${method} arrived in an unrecognized shape — declined rather than shown as a question`,
      );
    }
    // Everything else is a client capability we deliberately did not advertise
    // (`fs/*`, `terminal/*`) or a vendor extension we don't implement. A
    // blocking request MUST be answered or the agent parks forever, so refuse
    // it in-protocol — and say so once, since a refused extension can change
    // what the agent is able to do this turn.
    if (
      this.io?.write(
        encodeError(
          id,
          JSONRPC_METHOD_NOT_FOUND,
          `${method} is not implemented by this client`,
        ),
      ) !== true
    ) {
      this.options.logger?.warn(
        `acp: dropped the error reply to ${method} — stdin is closed`,
      );
    }
    if (this.options.declinedWithoutNotice?.includes(method) === true) {
      // A refusal its own agent absorbs. The notice above is a per-TURN
      // budget of one, so narrating a harmless refusal does not merely add
      // noise — it spends the slot, and a consequential refusal later in the
      // same turn then goes unmentioned. Measured: an ordinary planning turn
      // on cursor-agent 2026.08.04 sends `cursor/update_todos`, which would
      // have burnt it. Still recorded, on the debug channel.
      this.options.logger?.debug?.(
        `acp: declined ${method}; the agent handles that refusal itself`,
      );
      return [];
    }
    if (this.warnedUnsupportedRequest) {
      return [];
    }
    this.warnedUnsupportedRequest = true;
    return [
      {
        type: 'notice',
        message: `agent asked for '${method}', which this client does not implement; it was declined`,
      },
    ];
  }

  /**
   * Park a question and surface it as a card.
   *
   * `autoDecide` is deliberately NOT consulted, unlike the permission path
   * below: that hook resolves a PERMISSION posture (`auto` approves, plan
   * rejects), and a question has no safe machine answer — approving one on the
   * user's behalf invents an opinion they never gave. The same floor is
   * enforced again in `spawn-cli`, so neither layer relies on the other.
   */
  private onQuestionRequest(
    id: JsonRpcId,
    params: unknown,
    question: AcpQuestionProtocol,
  ): AgentEvent[] {
    const encodedId = encodeRequestId(id);
    this.parkedQuestions.set(encodedId, params);
    return [
      {
        type: 'approval_request',
        id: encodedId,
        toolName: question.toolName,
        input: params,
        requiresUserInteraction: true,
      },
    ];
  }

  private onPermissionRequest(id: JsonRpcId, params: unknown): AgentEvent[] {
    const root = asRecord(params);
    const toolCallRecord = root ? asRecord(root.toolCall) : null;
    // The permission request's own toolCall is a stub: it may omit the kind
    // `acceptEdits` decides on and the name the approval card shows. Both were
    // announced on the `tool_call` update for this id, so fall back to those
    // rather than deciding — or asking the user — on missing information.
    const toolCall = this.withCachedToolFacts(
      readToolCall(toolCallRecord ?? {}),
    );
    const options = readPermissionOptions(root?.options);

    const decision = this.options.autoDecide(toolCall);
    if (decision !== null) {
      const optionId = selectPermissionOption(options, decision === 'allow');
      this.reply(id, {
        outcome:
          optionId === null
            ? { outcome: 'cancelled' }
            : { outcome: 'selected', optionId },
      });
      return [];
    }

    const encodedId = encodeRequestId(id);
    this.parkedPermissions.set(encodedId, options);
    return [
      {
        type: 'approval_request',
        id: encodedId,
        toolName: toolCall.name,
        input: toolCall.rawInput,
      },
    ];
  }

  /** Restore the kind and name cached from this id's `tool_call` update. */
  private withCachedToolFacts(toolCall: AcpToolCall): AcpToolCall {
    const id = toolCall.toolCallId;
    if (id === '') {
      return toolCall;
    }
    return {
      ...toolCall,
      name:
        toolCall.name === '' ? (this.toolNames.get(id) ?? '') : toolCall.name,
      kind: toolCall.kind ?? this.toolKinds.get(id) ?? null,
      rawInput: toolCall.rawInput ?? this.toolInputs.get(id) ?? null,
    };
  }

  private onNotification(method: string, params: unknown): AgentEvent[] {
    if (method !== ACP_CLIENT_METHODS.sessionUpdate) {
      // Vendor notifications (`cursor/update_todos`, `cursor/task`, …) are
      // fire-and-forget by definition — ignoring one is a no-op, not a stall.
      return [];
    }
    const root = asRecord(params);
    const update = root ? asRecord(root.update) : null;
    if (!update) {
      return [];
    }
    return this.onSessionUpdate(asString(update.sessionUpdate), update);
  }

  private onSessionUpdate(
    kind: string | null,
    update: Record<string, unknown>,
  ): AgentEvent[] {
    if (this.replaying) {
      this.replayedUpdates += 1;
    }
    switch (kind) {
      case 'agent_message_chunk': {
        if (this.replaying) {
          return [];
        }
        const text = textOf(update.content);
        if (text === null) {
          return [];
        }
        this.textChunks.push(text);
        // The chunk streams as an EPHEMERAL delta; the row is written when the
        // block closes (see `pending`).
        return [
          ...this.appendPending('text', text),
          { type: 'text_delta', text },
        ];
      }
      case 'agent_thought_chunk': {
        if (this.replaying) {
          return [];
        }
        const text = textOf(update.content);
        // No ephemeral twin: `thinking_progress` carries a token COUNT, which
        // is claude's answer to redacted thinking and cannot express text.
        return text === null ? [] : this.appendPending('reasoning', text);
      }
      case 'tool_call': {
        if (this.replaying) {
          return [];
        }
        const toolCall = readToolCall(update);
        this.toolNames.set(toolCall.toolCallId, toolCall.name);
        if (toolCall.kind !== null) {
          this.toolKinds.set(toolCall.toolCallId, toolCall.kind);
        }
        if (toolCall.rawInput !== null) {
          this.toolInputs.set(toolCall.toolCallId, toolCall.rawInput);
        }
        return [
          // A tool call is a transcript row, so whatever text preceded it is a
          // finished block — closing it here is what keeps the interleaving
          // (say something → call a tool → say something) intact.
          ...this.flushPending(),
          {
            type: 'tool_call',
            id: toolCall.toolCallId,
            name: toolCall.name,
            input: toolCall.rawInput,
            // ACP classifies its own calls, so the transcript can say what the
            // agent DID without recognising this agent's tool names. Omitted
            // rather than defaulted when the agent sent none: `other` would
            // claim a classification nobody made.
            ...(toolCall.kind === null ? {} : { kind: toolCall.kind }),
          },
        ];
      }
      case 'tool_call_update': {
        if (this.replaying) {
          return [];
        }
        const toolCall = readToolCall(update);
        // Only a settled tool call closes the pair; `pending`/`in_progress`
        // updates are progress the transcript does not model.
        if (toolCall.status !== 'completed' && toolCall.status !== 'failed') {
          return [];
        }
        // A diff is the one thing an agent may report INSTEAD of arguments, so
        // it is normalized here rather than passed through as the raw ACP block
        // array: `{diffs}` is the shape the transcript renders as a diff, and it
        // carries the path an undisclosed edit is otherwise missing.
        const diffs = readAcpDiffs(update.content);
        return [
          ...this.flushPending(),
          {
            type: 'tool_result',
            id: toolCall.toolCallId,
            name:
              this.toolNames.get(toolCall.toolCallId) ??
              (toolCall.name.length > 0 ? toolCall.name : null),
            result:
              toolCall.rawOutput ??
              (diffs.length > 0 ? { diffs } : (update.content ?? null)),
            isError: toolCall.status === 'failed',
          },
        ];
      }
      case 'available_commands_update': {
        // The session's invokable set for this cwd — feeds the composer's `/`
        // autocomplete. Useful during a replay too (it is current state, not
        // history), so it is deliberately outside the replay guard.
        const commands = asArray(update.availableCommands)
          .map((entry) => {
            const record = asRecord(entry);
            return record ? asString(record.name) : null;
          })
          .filter((name): name is string => name !== null && name.length > 0);
        return commands.length > 0
          ? [{ type: 'slash_commands', commands }]
          : [];
      }
      case 'usage_update': {
        this.usage.contextUsed =
          asNumber(update.used) ?? this.usage.contextUsed;
        const cost = asRecord(update.cost);
        if (cost) {
          this.usage.costAmount = asNumber(cost.amount);
          this.usage.costCurrency = asString(cost.currency);
        }
        return [];
      }
      default:
        // user_message_chunk (our own prompt echoed back), plan/plan_update,
        // current_mode_update, config_option_update, session_info_update — all
        // real ACP updates this transcript does not model.
        return [];
    }
  }
}
