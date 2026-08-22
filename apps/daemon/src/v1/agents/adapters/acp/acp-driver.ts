import { asArray, asNumber, asRecord, asString } from '../../utils/json-util';
import type {
  AgentEvent,
  AgentReportedCommand,
  AgentTask,
  AgentTurnInput,
  AgentUsage,
  FollowUpMessage,
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
  readAcpConfigOption,
  readAcpCurrentModelId,
  readAcpModelConfigId,
  readAcpModels,
} from './acp-models';

/** What we sent, so the reply can be routed without a callback map. */
type PendingKind =
  | 'initialize'
  | 'session'
  /**
   * A `session/load`, kept apart from a `session/new` only so its REFUSAL can be
   * handled: both replies mean the same thing and route to `onSessionReady`, but
   * a load that fails is recoverable (open a fresh session, say the history is
   * gone) while a `session/new` that fails leaves nothing to run the turn on.
   */
  | 'session_load'
  | 'set_mode'
  | 'set_model'
  | 'set_model_parameter'
  | 'prompt';

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

/**
 * What one agent told us about a background sub-agent it launched, normalized.
 *
 * The reading itself belongs to the adapter (the params are that vendor's own
 * shape); what the driver owns is WHEN to ask for it and what to emit.
 */
export interface AcpDelegateFacts {
  /** The launching tool call's id — the anchor everything downstream joins on. */
  id: string;
  label: string | null;
  kind: string | null;
  prompt: string | null;
  model: string | null;
  durationMs: number | null;
}

/**
 * How ONE agent reports the background sub-agents it runs, since baseline ACP
 * models a delegation as an ordinary tool call and nothing more.
 *
 * Supplied by the adapter, never known here — the method name, the marker and
 * the params shape are that CLI's facts. What the driver owns is the LIFECYCLE:
 * recognise the launch so the delegate's block can open while it is still
 * working, ANSWER the announcement rather than declining it, and emit both as
 * `subagent_info` events.
 *
 * Answering matters more than it looks. cursor sends its announcement through
 * `connection.extMethod(...).catch(debugLog)` — a request whose outcome it
 * discards — so declining cost the turn nothing and was invisible, which is
 * exactly how every fact the CLI reports about its delegates (the brief, the
 * type, the model, the duration) came to be thrown away for two milestones
 * while the adapter declared the signal did not exist.
 */
export interface AcpDelegateProtocol {
  /** The agent→client method carrying the announcement. */
  method: string;
  /**
   * The `rawInput` entry that marks a tool call as a DELEGATION, so the block
   * can open at launch instead of at completion.
   *
   * A marker rather than a tool name, because an ACP `tool_call` carries no
   * machine name at all — only a human `title`, which cursor formats as
   * `Task: <description>` and so cannot be matched on. Measured on
   * cursor-agent 2026.08.11-e8db854: the launch arrives as
   * `rawInput: {"_toolName":"task"}` and its title is `Task: Subagent task`,
   * the description not yet known.
   */
  launchMarker: { key: string; value: string };
  /**
   * Read the announcement's params, or null when the shape is unrecognized —
   * which falls through to the ordinary decline, on the same reasoning as
   * {@link AcpQuestionProtocol.accepts}: a row built from a payload we could
   * not parse is worse than not having one.
   */
  read(params: unknown): AcpDelegateFacts | null;
  /**
   * The launching tool's own return value is this CLI's ACCOUNTING, not the
   * delegate's report — so it is dropped rather than presented as one.
   *
   * True for cursor, measured: the `task` call completes with
   * `rawOutput: {durationMs, isBackground}` and the delegate's actual findings
   * only ever appear in the MAIN agent's next message. Left in, the block framed
   * that object as `Result from <delegate>` and printed `{"durationMs": 15430,
   * "isBackground": false}` where the reader looks for what the delegate found.
   * The duration is not lost — it rides the announcement, which is where a fact
   * about the delegate belongs.
   *
   * False for a CLI whose delegate reports THROUGH that result (claude's `Task`
   * returns the delegate's own text), where dropping it would discard the answer.
   */
  resultIsBookkeeping: boolean;
  /**
   * `AdapterConfig.subagents.stepsUnavailableReason` — stamped onto every row
   * this protocol emits, so the block that has no thread to open carries the
   * reason with it rather than needing a second lookup.
   */
  stepsUnavailableReason: string | null;
}

/**
 * How ONE agent reports its own task list, since baseline ACP's `plan` update
 * is not what the shipped agents actually send.
 *
 * Supplied by the adapter — the method name and the params shape are that
 * vendor's facts. What the driver owns is the LIFECYCLE, and there is one thing
 * in it worth naming: the announcement arrives as a blocking REQUEST, so it must
 * be answered. Declining it (which is what happened for two milestones, quietly,
 * because `cursor/update_todos` is on `declinedWithoutNotice`) does not stall the
 * turn — the agent absorbs the refusal — it simply throws the list away.
 *
 * An adapter that declares none keeps the old behaviour, which is correct for an
 * agent that has no such channel.
 */
export interface AcpTodoProtocol {
  /** The agent→client method carrying the list. */
  method: string;
  /**
   * Read the params into the normalized announcement, or null when the shape is
   * unrecognized — which falls through to the ordinary decline, on the same
   * reasoning as {@link AcpQuestionProtocol.accepts}: a list built from a payload
   * we could not parse is worse than not having one.
   */
  read(params: unknown): AcpTodoUpdate | null;
}

/** What one agent told us about its task list, normalized. */
export interface AcpTodoUpdate {
  /** See {@link AgentEvent}'s `task_list`: whole list, or only the rows named. */
  mode: 'snapshot' | 'patch';
  tasks: AgentTask[];
  /** The tool call this belongs to, so its opaque row can be replaced by the list. */
  toolCallId: string | null;
}

/**
 * How full one agent's window is, as read from OUTSIDE the protocol.
 *
 * Deliberately the three fields a meter needs and nothing else — not
 * `AgentContextUsage`, which is a whole breakdown for a panel. The driver's job
 * here is one figure and its denominator; anything richer would make this seam
 * the second place a breakdown is defined.
 */
export interface AcpContextReading {
  /** What the window currently holds, or null when the source cannot say. */
  usedTokens: number | null;
  /** What it is measured against, or null. */
  windowTokens: number | null;
  /** Which model that window belongs to, when the source named one. */
  model: string | null;
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
   * How this agent reports its background sub-agents, or absent when it does
   * not — in which case a delegation reads as the plain tool call it is.
   */
  delegate?: AcpDelegateProtocol;
  /** How this agent reports its own task list, or absent when it does not. */
  todos?: AcpTodoProtocol;
  /**
   * How full this agent's window is, read OFF-PROTOCOL — absent for an agent
   * that reports it on the wire, or not at all.
   *
   * ACP has no context accounting: an agent sends no `usage_update` and its
   * prompt reply carries no window, so an ACP turn's meter had nothing to draw
   * and the ring sat empty for the life of the chat. A CLI can still KEEP that
   * accounting somewhere the adapter can read — cursor writes a full breakdown
   * per turn into its own session store — and this is the seam that brings it
   * onto the same plane every other agent's figures ride. The reading itself is
   * the adapter's business; what the driver owns is WHEN to take one, which is
   * why this is a function of the session id and not a value.
   *
   * It reaches BOTH planes — the live `context_progress` while the turn runs,
   * and the turn's own `turn_complete` usage after it ends (see
   * {@link AcpTurnDriver.contextReading}). Live alone was the first version and
   * was reported straight back: that plane is dropped on settle, so the ring it
   * feeds was filled during a turn and empty between turns.
   *
   * SYNCHRONOUS on purpose: it is consulted from the two handlers that build an
   * event list and return it, so an async reading would have to be published
   * out of band, past the ordering every other event in the turn is subject to.
   * An adapter whose source cannot be read synchronously should cache it rather
   * than make this seam async for everyone.
   */
  readContext?: (sessionId: string) => AcpContextReading | null;
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
   * The turn's instruction text, given whether the call tools were registered
   * and whether the host preamble still needs saying. Supplied by the adapter
   * so the include-the-callee-block rule stays owned by
   * `AgentAdapter.composeSystemPrompt` rather than re-derived per protocol.
   *
   * The driver decides only the two BOOLEANS — what the text is remains the
   * adapter's answer.
   */
  composeSystemPrompt: (granted: boolean, includePreamble: boolean) => string;
  logger?: { warn(message: string): void; debug?(message: string): void };
  /**
   * Extra `clientCapabilities._meta` this client declares — a VENDOR extension
   * bag, so the adapter owns its contents and this file never spells one.
   *
   * cursor uses it to unlock its parameterized model picker, which is what turns
   * one opaque composed model id into a bare name plus a real effort vocabulary.
   * An agent that does not know the key ignores it, so sending it is free.
   */
  clientMeta?: Readonly<Record<string, unknown>>;
  /**
   * What this turn should put the agent on: a model, then the parameters to set
   * after it — the shape a CLI needs when its model and its reasoning effort are
   * SEPARATE config options rather than one composed id.
   *
   * Supplied by the adapter, because splitting a stored id into the two is that
   * CLI's syntax. Absent means "apply `input.model` verbatim and nothing else",
   * which is what an agent with a single opaque model id wants.
   *
   * ORDER is the contract, not a detail: a parameter's very existence depends on
   * the current model (cursor's `auto-smart` has none at all), so the model
   * frame must precede them. They travel on one ordered stdio stream, so sending
   * in order is applying in order.
   */
  modelSelection?: {
    model: string | null;
    parameters: readonly AcpModelParameter[];
  } | null;
}

/**
 * One config option a turn sets after its model — a reasoning effort, a context
 * size.
 *
 * `alternateIds` exists because a config option's id belongs to the MODEL, and
 * one agent's models can name the same axis differently: cursor's
 * `claude-opus-5` calls it `effort` and its `gpt-5.2` calls it `reasoning`
 * (probed 2026-08-19 on 2026.08.11-e8db854). The adapter knows its own CLI's
 * spellings; the driver picks whichever one the current model enumerated. Left
 * empty, `id` is sent verbatim — which is every agent whose axis has one name.
 */
export interface AcpModelParameter {
  id: string;
  value: string;
  /** Other ids this SAME setting is known by, most-preferred first. */
  alternateIds?: readonly string[];
  /**
   * Whether the prompt must WAIT for this frame's reply.
   *
   * Every other frame this driver sends before a prompt is pipelined, on the
   * reasoning that one ordered stdio stream already puts them in order — see
   * {@link AcpTurnDriver.applyModel}. That holds for anything the agent reads
   * per REQUEST, and it does not hold for a setting the agent binds when the
   * TURN begins.
   *
   * Measured on cursor-agent 2026.08.11-e8db854, same profile, same frames,
   * same values, only the waiting differing: with the `context` reply awaited
   * the CLI's own accounting reports a 1,000,000-token window; with the frame
   * and the prompt sent back to back it reports 300,000 — the model's default —
   * even though the reply confirms `context = 1m`. So the option was set and
   * the turn had already started without it.
   *
   * The cost is one round trip on the turns that ask, and only those. It is not
   * set on the effort axis: nothing has measured that one to bind at turn
   * start, and the deferral was priced at ~1.4s per turn when it was considered
   * for the model frame.
   */
  applyBeforePrompt?: boolean;
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
  /**
   * Request ids of the parameter frames the PROMPT is waiting on, and the
   * prompt held behind them.
   *
   * Only for a parameter the adapter marked `applyBeforePrompt` — see that
   * field for the measurement. Empty on every other turn, which is almost all
   * of them, and the prompt goes out pipelined exactly as before.
   *
   * Ids rather than a count, because EVERY `set_model_parameter` reply reaches
   * `releasePrompt` while only some of those frames block: a counter is
   * decremented by replies that never incremented it. A turn setting both an
   * effort (which does not block) and a context window (which does) would then
   * release on the effort's reply and run at the model's default window.
   */
  private readonly promptBlockers = new Set<JsonRpcId>();
  private promptHeld = false;
  /**
   * The id of the most recent `session/prompt` — the only one whose reply ends
   * the turn.
   *
   * A second is in flight while a mid-turn message is being delivered
   * ({@link sendFollowUp}): this CLI answers the SUPERSEDED prompt with its own
   * reply, and a turn that emitted its terminal there would settle the run in
   * the middle of answering the message the user had just pushed through —
   * under `stopReason: "cancelled"`, reading as a Stop nobody pressed. Matched
   * by id rather than by counting what is outstanding, because the two replies
   * are not ordered: a count settles the turn on whichever arrives second,
   * which is the superseded one whenever the agent's cancel is the slower half.
   */
  private latestPromptId: JsonRpcId | null = null;
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
  /**
   * The last off-protocol context reading this turn took, or null.
   *
   * KEPT rather than merely emitted, and that is the fix for the reported "the
   * panel says 70% and the circle beside it is empty". A reading rides the
   * EPHEMERAL live plane, which the client drops when the run settles — so the
   * ring was fed for the length of a turn and lost its only figure the moment
   * the turn ended, while the readout behind it kept answering off the same
   * file on demand. Held here, the same number also reaches `turn_complete`
   * (see {@link buildUsage}), which is the durable half every other CLI's ring
   * is drawn from between turns.
   */
  private contextReading: AcpContextReading | null = null;
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
   * Tool calls THIS turn recognised as sub-agent launches, so their result can
   * be treated as the CLI's accounting rather than the delegate's answer (see
   * {@link AcpDelegateProtocol.resultIsBookkeeping}).
   */
  private readonly delegateToolCalls = new Set<string>();
  /**
   * The MCP servers this turn actually registered. `composePrompt` derives the
   * call-surface grant from this rather than from a separate flag, so the
   * "May call" block and the tools it names cannot disagree.
   */
  private grantedMcpServers: AcpMcpServerHttp[] = [];
  /** This turn resumed via `session/load` — and its load actually succeeded. */
  private resumed = false;
  /** The model asked for, so a refusal can name it. */
  private requestedModelId: string | null = null;
  /** The last `<id>=<value>` parameter asked for, so a refusal can name it. */
  private requestedParameter: string | null = null;

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

  onMessage(obj: unknown): AgentEvent[] {
    const message = classifyMessage(obj);
    switch (message.kind) {
      case 'response': {
        const kind = this.pending.get(message.id);
        if (kind === undefined) {
          return [];
        }
        this.pending.delete(message.id);
        return this.onReply(kind, message.result, message.id);
      }
      case 'error': {
        const kind = this.pending.get(message.id);
        if (kind === undefined) {
          return [];
        }
        this.pending.delete(message.id);
        return this.onErrorReply(kind, message.message, message.id);
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

  /** Send one request, answering whether it actually went out. */
  private request(
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
   * the two frames whose reply changes the turn's own state need: a parameter
   * the prompt is held behind ({@link promptBlockers}) and the prompt itself
   * ({@link latestPromptId}).
   */
  private sendRequest(
    method: string,
    params: unknown,
    kind: PendingKind,
    events: AgentEvent[],
  ): JsonRpcId | null {
    const id = this.nextRequestId++;
    this.pending.set(id, kind);
    if (this.io?.write(encodeRequest(id, method, params)) !== true) {
      this.pending.delete(id);
      events.push({
        type: 'error',
        message: `acp: failed to send ${method} (the agent's stdin is closed)`,
      });
      return null;
    }
    return id;
  }

  private reply(id: JsonRpcId, result: unknown): void {
    if (this.io?.write(encodeResult(id, result)) !== true) {
      this.options.logger?.warn(
        `acp: dropped a reply to request ${String(id)} — stdin is closed`,
      );
    }
  }

  // --- inbound ------------------------------------------------------------

  private onReply(
    kind: PendingKind,
    result: unknown,
    id: JsonRpcId,
  ): AgentEvent[] {
    switch (kind) {
      case 'initialize':
        return this.onInitialized(result);
      case 'session':
      case 'session_load':
        // One reply shape, one handler: a loaded session is as ready as a new
        // one, and `onSessionReady` reads the resume id back for the load case
        // (`session/load` mints none — the id is the one we sent).
        return this.onSessionReady(result);
      case 'set_mode':
        // A mode the agent accepted needs no announcement; a mode it rejected
        // arrives as an error reply instead (see onErrorReply).
        return [];
      case 'set_model':
        // Same contract as `set_mode` above: silence on acceptance, and a
        // `notice` from `onErrorReply` on a refusal.
        return [];
      case 'set_model_parameter':
        // Silent too — but it may be the frame the prompt is waiting on.
        return this.releasePrompt(id);
      case 'prompt':
        return this.onPromptComplete(result, id);
    }
  }

  private onErrorReply(
    kind: PendingKind,
    message: string,
    id: JsonRpcId,
  ): AgentEvent[] {
    if (kind === 'session_load') {
      // The thread could not be reopened — so run the turn on a FRESH session
      // rather than ending it. A hard failure here is a dead end by
      // construction: every later turn of that chat resumes the same id, so the
      // conversation is unusable for good, and the user sees a turn that
      // finished instantly having written nothing. Losing the history is bad;
      // losing the chat is worse, and the notice is what keeps the loss from
      // being silent.
      //
      // Reachable in the ordinary way — the agent's store is not geniro's to
      // guarantee, and a chat whose session store was deleted (a cleared
      // userData dir, or the per-turn-profile defect this shipped with) is
      // exactly this. Measured against 2026.08.11-e8db854: a load of an id the
      // profile does not hold answers
      // `-32602 Invalid params {"message":"Session \"…\" not found"}`.
      const events: AgentEvent[] = [
        {
          type: 'notice',
          message: `agent could not reopen this conversation (${message}) — this turn runs on a fresh session, without the earlier history in its context`,
        },
      ];
      // Undo the replay bookkeeping the load armed: nothing is being replayed
      // now, and leaving `replaying` set would drop every transcript update of
      // the turn we are about to run.
      this.replaying = false;
      this.resumed = false;
      this.replayStartedAt = null;
      this.replayedUpdates = 0;
      this.request(
        ACP_AGENT_METHODS.sessionNew,
        {
          cwd: this.options.input.cwd,
          mcpServers: this.grantedMcpServers,
        },
        'session',
        events,
      );
      return events;
    }
    if (kind === 'set_mode') {
      // A refused mode is a degrade, not a failure: the turn still runs, just
      // in the agent's default mode. Say so rather than silently downgrading —
      // and say it at `warning`, which is what "a degrade, not a failure" has
      // meant all along and could not be expressed until the severity existed.
      return [
        {
          type: 'notice',
          severity: 'warning',
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
    if (kind === 'set_model_parameter') {
      // A degrade, like the two above: the turn runs, on the parameter value the
      // agent already had. Never silent, because a run the user set to `xhigh`
      // quietly thinking at `high` is a wrong turn that reports success — and
      // this arm is genuinely reachable, since a value is only offered for SOME
      // models and a legacy chat's stored id can name one the model dropped.
      //
      // A `warning`, not the default severity. Nothing failed: the turn ran and
      // went on running, which is precisely what made the full-width red panel
      // wrong — reported as "a strange error … and then it carried on working".
      // The frame is now only sent where it CANNOT be checked first (see
      // `applyModelParameters`), so this arm is the honest remainder rather than
      // the ordinary case it used to be.
      return [
        {
          type: 'notice',
          severity: 'warning',
          message: `the agent declined '${this.requestedParameter ?? ''}' (${message}) — the turn keeps its own value for it`,
        },
        // A refusal releases the prompt too: the setting did not apply, and a
        // turn must not be stranded behind a frame that was never going to
        // land. The notice above is what says so.
        ...this.releasePrompt(id),
      ];
    }
    if (kind === 'prompt' && id !== this.latestPromptId) {
      // The SUPERSEDED prompt failed rather than answering `cancelled`, and an
      // `error` is terminal downstream — so returning one here settles the run
      // as failed while the message the user just pushed through is still being
      // answered. Same rule as {@link onPromptComplete}: only the most recent
      // prompt may end the turn. The open block is still closed, exactly as a
      // cancel closes one.
      return this.flushPending();
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
        'session_load',
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
    // Before the prompt goes out, so a RESUMED conversation shows what it
    // already holds for the whole of this turn instead of only once the turn
    // ends. A fresh session has written nothing yet and reads as no figure,
    // which is the honest answer for a window that holds nothing.
    this.emitContextReading(events);

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
      // never be silent. WHICH message is truthful depends on what we sent: a
      // reply that enumerated modes and did not include this one is a refusal,
      // while one that enumerated none says nothing about what the agent offers.
      //
      // The `resumed` arm was written on the belief that a `session/load` reply
      // carries no `modes` block at all. That is REFUTED — measured on
      // 2026.08.11-e8db854, a load reply carries `modes`
      // (`currentModeId: 'agent'`, three `availableModes`), `models` and
      // `configOptions` alike, so a resumed turn takes the same path as a fresh
      // one and this arm is only reached if a build stops sending them. It was
      // mis-recorded because the reply could not be observed: cursor's session
      // store lived inside a per-turn config directory that was deleted on
      // settle, so every resume failed before its reply existed.
      events.push({
        type: 'notice',
        message: this.resumed
          ? `the '${this.options.preferredModeId}' mode could not be set on a resumed session — this turn runs under the agent's current mode`
          : `agent does not offer the '${this.options.preferredModeId}' mode — this turn runs under the agent's current mode instead`,
      });
    }

    this.applyModel(root, events);

    // HELD when a parameter must be in force before the turn begins, and
    // released by its reply (`releasePrompt`). Everything else about the
    // ordering is unchanged: with no such parameter this is the same
    // back-to-back send it has always been.
    if (this.promptBlockers.size > 0) {
      this.promptHeld = true;
      return events;
    }
    this.sendPrompt(events);
    return events;
  }

  /** The turn's prompt — composed once, whether it goes now or after a reply. */
  private sendPrompt(events: AgentEvent[]): void {
    if (this.sessionId === null) {
      return;
    }
    const id = this.sendRequest(
      ACP_AGENT_METHODS.sessionPrompt,
      {
        sessionId: this.sessionId,
        prompt: this.composePromptBlocks(events),
      },
      'prompt',
      events,
    );
    if (id !== null) {
      this.latestPromptId = id;
    }
  }

  /**
   * Deliver a user message into the turn already running — {@link
   * TurnDriver.sendFollowUp}.
   *
   * **This CLI has no frame that ADDS to a prompt in flight, and a second
   * `session/prompt` is not one: it CANCELS the first.** Probed on
   * 2026.08.11-e8db854 — a counting turn interrupted twelve seconds in answered
   * `{"stopReason":"cancelled"}` while the injected prompt ran to `end_turn`
   * and plainly held the conversation ("STOP counting, reply BANANA" got
   * `BANANA`). The adapter declares that as `followUp.interrupts`, so the user
   * is told what a press does before they make it; nothing here decides it.
   *
   * The words the interrupted stretch already produced are NOT lost: they
   * streamed as ordinary chunks and the open block is closed when its own reply
   * lands, exactly as a cancel closes one.
   */
  sendFollowUp(message: FollowUpMessage): boolean {
    // No session yet, or a prompt still held behind a parameter frame: in both
    // the turn's OWN prompt has not gone out, so there is nothing to interrupt
    // and a follow-up would race it. False leaves the message queued, which is
    // the safe answer.
    if (this.sessionId === null || this.promptHeld) {
      return false;
    }
    const events: AgentEvent[] = [];
    const images = buildAcpImageBlocks(message.images);
    // Gated on the agent's OWN advertised capability, the same check the turn's
    // opening prompt passes through: an unadvertised image block earns an error
    // reply, which here would lose the message rather than merely the picture.
    const withImages = images.length > 0 && this.capabilities.promptImage;
    if (images.length > 0 && !withImages) {
      events.push({
        type: 'notice',
        message: `agent does not accept image prompts — ${images.length} attached image${images.length === 1 ? ' was' : 's were'} not sent with this message`,
      });
    }
    const blocks: AcpContentBlock[] = [
      ...(withImages ? images : []),
      { type: 'text', text: message.text },
    ];
    const id = this.sendRequest(
      ACP_AGENT_METHODS.sessionPrompt,
      { sessionId: this.sessionId, prompt: blocks },
      'prompt',
      events,
    );
    const sent = id !== null;
    if (sent) {
      this.latestPromptId = id;
      // Close the open block HERE rather than leaving it to the superseded
      // reply: what the agent had already said is finished the moment we
      // interrupt it, and closing at the interrupt is what keeps it ONE row
      // instead of a blob merged with whatever the agent emits in the window
      // between our frame and its own cancel.
      //
      // It does NOT decide where the row lands relative to the user's message.
      // The turn's events are persisted through a serialized chain while
      // `deliverIntoRunningTurn` reserves its own seq directly, so the user row
      // wins and the interrupted text is filed under it — measured end to end.
      // Changing that needs an ordering seam on the turn handle, not a flush
      // moved earlier.
      events.push(...this.flushPending());
    }
    for (const event of events) {
      this.io?.emit(event);
    }
    return sent;
  }

  /**
   * One awaited parameter frame has been answered — send the prompt once the
   * last of them is in.
   *
   * Called for a REFUSAL as well as an acceptance: a turn must not be stranded
   * because a setting did not apply. The refusal itself is already narrated by
   * `onErrorReply`, so the turn runs on whatever the agent kept, which is what
   * it would have done had the frame never been sent.
   */
  private releasePrompt(id: JsonRpcId): AgentEvent[] {
    // A no-op for a frame that never blocked, which is what keeps a parameter
    // sent WITHOUT `applyBeforePrompt` from releasing one that was.
    this.promptBlockers.delete(id);
    if (this.promptBlockers.size > 0 || !this.promptHeld) {
      return [];
    }
    this.promptHeld = false;
    const events: AgentEvent[] = [];
    this.sendPrompt(events);
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
    if (this.sessionId === null) {
      return;
    }
    // The adapter's split when it supplied one, else the stored id verbatim.
    const selection = this.options.modelSelection ?? {
      model: this.options.input.model ?? null,
      parameters: [],
    };
    const wanted = selection.model?.trim();
    // Parameters are applied EVEN WHEN the model needs no change — they are a
    // separate axis, and a run that keeps the agent's current model while
    // choosing a different effort is the ordinary case for a chat left on
    // "default model". Both early returns below therefore fall through to them.
    if (!wanted || readAcpCurrentModelId(sessionResult) === wanted) {
      // The one path where the reply on hand DESCRIBES the model this turn will
      // run on — nothing is switching — so a parameter it does not offer can be
      // answered here instead of by a refusal from the agent.
      this.applyModelParameters(
        selection.parameters,
        events,
        sessionResult,
        true,
      );
      return;
    }
    // The offers check applies only when the agent actually ENUMERATED a
    // vocabulary. It exists to save a round-trip to be refused, and that is
    // worth doing only against a reply that says what is on offer — silence is
    // not a refusal. `readAcpModels` states the contract this obeys: an empty
    // result means "the agent said nothing", never "the agent has no models",
    // and every caller must read it as unknown.
    //
    // A reply is free to say nothing here, and reading silence as "not offered"
    // would refuse LOCALLY — asserting something the agent never said, on the
    // path every turn after a chat's first takes (cursor cannot keep its
    // process, so those all resume). Sending it and letting the agent answer is
    // strictly better: `onErrorReply` turns a genuine refusal into the same
    // notice, earned rather than assumed. So there is no branch on `resumed`.
    //
    // A `session/load` reply was recorded here as carrying no model block at
    // all. REFUTED on 2026.08.11-e8db854: it carries `models.currentModelId`
    // AND a full `configOptions` list with each option's `currentValue`, so a
    // resumed turn reads the same fields as a fresh one and applies the model
    // through `set_config_option` exactly as it does on turn 1 (measured:
    // `model=claude-opus-5` then `effort=xhigh` both ACCEPTED on a loaded
    // session). The old note was written when no resume could succeed — the
    // session store was being deleted with the turn's config directory.
    const offered = readAcpModels(sessionResult);
    if (offered.length > 0 && !acpOffersModel(sessionResult, wanted)) {
      // Never silent, for the reason the mode degrade above is not: a node the
      // user pointed at one model quietly running on another is a wrong turn
      // that reports success.
      events.push({
        type: 'notice',
        message: `agent does not offer the model '${wanted}' — this turn runs on the agent's current model instead`,
      });
      // Deliberately WITHOUT the parameters. They belong to the model that was
      // refused, and setting them against whichever model the agent stays on
      // would apply half of a selection the user never made.
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
      // AFTER the model frame, never instead of it: a parameter's own existence
      // depends on which model is current, so this ordering is the contract —
      // and it is also why nothing may be checked locally here. This reply
      // describes the model being switched AWAY from.
      this.applyModelParameters(
        selection.parameters,
        events,
        sessionResult,
        false,
      );
      return;
    }
    this.request(
      ACP_AGENT_METHODS.sessionSetModel,
      { sessionId: this.sessionId, modelId: wanted },
      'set_model',
      events,
    );
    this.applyModelParameters(
      selection.parameters,
      events,
      sessionResult,
      false,
    );
  }

  /**
   * Set the model's own parameters — a reasoning effort, a context size — after
   * the model frame and before the prompt.
   *
   * Each frame carries `configId`/`value`, which is the only shape this protocol
   * has for a parameter. An agent with no config-option support answers
   * `-32601` and the turn continues on its defaults.
   *
   * `describesTurnModel` is the whole of what makes a LOCAL answer legitimate,
   * and it is why this cannot simply check every parameter. A config option's
   * available values belong to the model that was current when the reply was
   * written, so:
   *
   * - When the turn is NOT switching models, that reply describes the model this
   *   turn will run on, so the vocabulary on hand is the right one and a value
   *   outside it can be refused here — with a sentence naming what the model
   *   does take, rather than by spending a round-trip to be told `Invalid
   *   params`.
   * - When the turn IS switching, the reply describes the PREVIOUS model and
   *   says nothing about the new one, so the frame goes out optimistically and
   *   the agent answers. Waiting for the model reply first would make it
   *   checkable — that reply carries the new model's full option list — and it
   *   was measured rather than assumed: the agent does NOT serialize the model
   *   switch against the prompt, so deferring the prompt behind that reply cost
   *   ~1.4s of added latency per turn (first `session/update` at ~1.6s
   *   pipelined vs ~3.0s deferred, cursor-agent 2026.08.11-e8db854). A second
   *   of every turn is too much to pay for a better message on a minority path.
   *
   * The vocabulary really is per-MODEL, which the config's `efforts` list had
   * recorded as a possibility and this now answers with measurements (same
   * build, 2026-08-19): `claude-opus-5` offers `low|medium|high|xhigh|max`,
   * `grok-4.6` offers the same minus `max`, and `auto-smart` and `composer-2.5`
   * enumerate no `effort` option at all — so a chat that remembers `max` per CLI
   * and is then pointed at Grok asks for a value that model has never had.
   */
  private applyModelParameters(
    parameters: readonly AcpModelParameter[],
    events: AgentEvent[],
    sessionResult: unknown,
    describesTurnModel: boolean,
  ): void {
    if (this.sessionId === null) {
      return;
    }
    for (const parameter of parameters) {
      const configId = describesTurnModel
        ? this.resolveParameterId(parameter, sessionResult)
        : parameter.id;
      if (
        describesTurnModel &&
        this.refuseUnofferedParameter(
          { ...parameter, id: configId },
          sessionResult,
          events,
        )
      ) {
        continue;
      }
      this.requestedParameter = `${configId}=${parameter.value}`;
      const id = this.sendRequest(
        ACP_AGENT_METHODS.sessionSetConfigOption,
        {
          sessionId: this.sessionId,
          configId,
          value: parameter.value,
        },
        'set_model_parameter',
        events,
      );
      // Recorded only for a frame that really went out — `sendRequest` un-pends
      // one it could not write, and a blocker with no reply coming would hold
      // the prompt for ever.
      if (parameter.applyBeforePrompt && id !== null) {
        this.promptBlockers.add(id);
      }
    }
  }

  /**
   * Which SPELLING of this setting the current model actually offers.
   *
   * One setting can be named differently by different models of one agent, and
   * that is a real property of this protocol rather than a quirk to paper over:
   * a config option's id belongs to the model, and the vendor is free to call
   * the same axis two things. Measured on cursor-agent 2026.08.11-e8db854 —
   * `claude-opus-5` and `grok-4.6` call the reasoning axis `effort`, `gpt-5.2`
   * calls it `reasoning`, and sending the other name is
   * `-32602 Unknown model config option`. So a caller that knows its CLI's
   * spellings supplies them (`alternateIds`) and the FIRST one this model
   * enumerates wins.
   *
   * Only reachable where the reply describes the turn's model, for the same
   * reason the refusal above is: the ids on a reply about a different model say
   * nothing about this one. Nothing offered, nothing known — the caller's own
   * id goes out and the agent answers.
   */
  private resolveParameterId(
    parameter: AcpModelParameter,
    sessionResult: unknown,
  ): string {
    for (const id of [parameter.id, ...(parameter.alternateIds ?? [])]) {
      if (readAcpConfigOption(sessionResult, id) !== null) {
        return id;
      }
    }
    return parameter.id;
  }

  /**
   * Whether this parameter is one the CURRENT model cannot take — and if so,
   * says so instead of sending it.
   *
   * Only ever consulted against a reply that describes the model the turn will
   * run on (see `describesTurnModel` above). Silence is not a refusal here
   * either: an agent that enumerated NO options for this id has said nothing
   * about it, so the frame still goes out and the agent answers.
   *
   * The notice is a `warning`, not the default severity: nothing failed. The
   * turn runs, on this model's own value for the setting, and the previous
   * rendering — the full-width red panel every daemon advisory wears — is what
   * got this reported as "a strange error … and then it carried on working".
   */
  private refuseUnofferedParameter(
    parameter: { id: string; value: string },
    sessionResult: unknown,
    events: AgentEvent[],
  ): boolean {
    const option = readAcpConfigOption(sessionResult, parameter.id);
    if (option === null) {
      // The model offers no such setting AT ALL, which for cursor is `effort` on
      // `auto-smart` and `composer-2.5` — the agent's own words for it are
      // `Unknown model config option: effort`.
      if (!this.sessionOffersConfigOptions(sessionResult)) {
        return false;
      }
      events.push({
        type: 'notice',
        severity: 'warning',
        message: `this model has no '${parameter.id}' setting — the turn runs without it`,
      });
      return true;
    }
    if (option.options.length === 0) {
      return false;
    }
    if (option.options.some(({ value }) => value === parameter.value)) {
      return false;
    }
    events.push({
      type: 'notice',
      severity: 'warning',
      message: `this model does not offer '${parameter.id}=${parameter.value}' — the turn runs at '${option.currentValue ?? 'its own value'}' (it offers ${option.options.map(({ value }) => value).join(', ')})`,
    });
    return true;
  }

  /**
   * Whether the reply enumerated a config-option list at all.
   *
   * The guard on the "no such setting" arm above: an agent that sent no
   * `configOptions` (the pre-1.0 shape, or one that simply says nothing) has
   * not declared the absence of anything, and reading its silence as a refusal
   * would drop every parameter on that transport.
   */
  private sessionOffersConfigOptions(sessionResult: unknown): boolean {
    return asArray(asRecord(sessionResult)?.configOptions).length > 0;
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
   * only supplies the two facts the protocol knows: whether the call tools
   * ended up registered, and whether the host preamble still needs saying.
   *
   * **The preamble is withheld on a RESUMED session, and that is a cost fix
   * with a real number behind it.** Prompt text is part of the conversation
   * here, not out-of-band like claude's `--append-system-prompt`: one turn is
   * one process, the next `session/load`s the stored session, so every block
   * this turn prepends is replayed to every later turn. Re-sending the ~1.1KB
   * preamble each time put roughly 40 copies (~11k tokens) inside a
   * 40-message thread's window — the same window the app's own context readout
   * reports on. A load has already replayed it, so saying it again buys
   * nothing.
   *
   * Only the PREAMBLE is dropped. The call-surface block still rides every
   * turn, because it is true only while those tools are actually registered
   * this turn — withholding it on a resume would tell an agent it can still
   * route work through tools this process never got, which the adapter rules
   * call out as silent by construction.
   */
  private composePrompt(): string {
    const instructions = this.options.composeSystemPrompt(
      this.grantedMcpServers.length > 0,
      !this.resumed,
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

  private onPromptComplete(result: unknown, id: JsonRpcId): AgentEvent[] {
    if (id !== this.latestPromptId) {
      // This reply answers a prompt we superseded ourselves — `sendFollowUp`
      // sent a second `session/prompt`, which this CLI answers by cancelling
      // the first. The turn is not over: emitting the terminal here would
      // settle the run while the message the user just pushed through is being
      // answered, and `stopReason: "cancelled"` would badge it as a Stop nobody
      // pressed.
      //
      // The open block is still CLOSED, exactly as a real cancel closes one.
      // Usually there is nothing left to close — `sendFollowUp` flushes at the
      // moment it interrupts, so the row lands above the message that caused
      // it — and what this catches is the chunks the agent emits between our
      // frame and its own cancel.
      return this.flushPending();
    }
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
    // The turn is over, so the last block has no more chunks coming — this
    // is the ONLY close for a reply that ended without a tool call after it.
    const events: AgentEvent[] = [...this.flushPending()];
    // AHEAD of `turn_complete`, which is what settles the run: the live plane a
    // context reading rides is cleared on settle, so one emitted after it would
    // be published into a state the client has already been told to drop.
    this.emitContextReading(events);
    events.push({
      type: 'turn_complete',
      usage: this.buildUsage(),
      stopReason: rawStopReason,
      finalText: text.length > 0 ? text : null,
    });
    return events;
  }

  /**
   * Take one off-protocol context reading, when this agent has a source for
   * one, and put it on the turn's event stream.
   *
   * Total by construction — a source that throws, has nothing yet, or cannot
   * name a used figure is simply no reading. This is a meter, and no meter is
   * worth failing a turn over.
   */
  private emitContextReading(events: AgentEvent[]): void {
    const read = this.options.readContext;
    if (read === undefined || this.sessionId === null) {
      return;
    }
    let reading: AcpContextReading | null;
    try {
      reading = read(this.sessionId);
    } catch (err) {
      this.options.logger?.warn(
        `acp context reading failed (the turn is unaffected): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (reading === null || reading.usedTokens === null) {
      return;
    }
    // Remembered before it is published, so the turn's own `turn_complete`
    // carries it too — see the field.
    this.contextReading = reading;
    events.push({
      type: 'context_progress',
      contextTokens: reading.usedTokens,
      contextWindowTokens: reading.windowTokens,
      contextModel: reading.model,
    });
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
      // ACP has no prompt-cache accounting on the wire — `UsageUpdate` carries
      // occupancy and a price and nothing about caching — and no output
      // breakdown, so an agent's thinking is inside `outputTokens` with no way
      // to separate it. Null rather than 0: the reading does not exist.
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      // ACP reports context occupancy directly (`UsageUpdate.used`), so unlike
      // the claude adapter there are no cache counters to sum.
      //
      // Then the OFF-PROTOCOL reading, and only then the plain input count.
      // The order is by what each figure actually measures: `used` and the
      // reading are both the window's occupancy — one stated on the wire, one
      // read out of the CLI's own accounting — while `inputTokens` is the
      // prompt of a single request, which is a different quantity that merely
      // beats nothing. Putting the reading here is what keeps the ring drawn
      // between turns rather than only during one; see {@link contextReading}.
      contextTokens:
        this.usage.contextUsed ??
        this.contextReading?.usedTokens ??
        this.usage.inputTokens,
      // ACP never reports the model's window size — `UsageUpdate` carries only
      // occupancy — so a denominator can only come from the off-protocol
      // reading. Absent that, the consumer shows the count with no denominator
      // rather than this client claiming a window no agent stated.
      contextWindowTokens: this.contextReading?.windowTokens ?? null,
      // From the same reading as the window and never on its own: a model id
      // here is a label ON that denominator, so one without the other names
      // something no figure is being measured against.
      contextModel:
        this.contextReading?.windowTokens == null
          ? null
          : this.contextReading.model,
      // The field is `costUsd`: report an amount only when the agent priced the
      // turn in USD, rather than silently relabelling another currency.
      costUsd:
        this.usage.costCurrency?.toUpperCase() === 'USD'
          ? this.usage.costAmount
          : null,
      // ACP has no turn-timing channel at all: `session/prompt` answers with a
      // stop reason, and `UsageUpdate` carries token occupancy and a price and
      // no clock. Deliberately NOT timed here from the driver's own turn
      // boundaries — that would be a wall clock wearing the CLI's name, and it
      // would count a stretch parked on `session/request_permission` as work
      // the agent did. The consumer measures the wall clock where this is null
      // and knows that is what it has.
      durationMs: null,
      apiMs: null,
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
    const delegate = this.options.delegate;
    if (delegate !== undefined && method === delegate.method) {
      const facts = delegate.read(params);
      if (facts !== null) {
        // ANSWERED, not declined. The agent discards the outcome either way, so
        // this changes nothing about the turn — what it changes is that the
        // delegate's brief, type, model and duration reach the transcript
        // instead of being refused and dropped.
        this.reply(id, {});
        return [this.delegateEvent(facts)];
      }
      this.options.logger?.warn(
        `acp: ${method} arrived in an unrecognized shape — declined rather than recorded as a sub-agent`,
      );
    }
    const todos = this.options.todos;
    if (todos !== undefined && method === todos.method) {
      const update = todos.read(params);
      if (update !== null) {
        // ANSWERED. Like the delegate announcement, the agent discards the
        // outcome either way, so this changes nothing about the turn — what it
        // changes is that the task list reaches the transcript instead of being
        // refused and dropped, which is what the user could not see.
        this.reply(id, {});
        return [{ type: 'task_list', ...update }];
      }
      this.options.logger?.warn(
        `acp: ${method} arrived in an unrecognized shape — declined rather than recorded as a task list`,
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

  /**
   * The anchor row for a tool call that IS a delegation, or nothing.
   *
   * Reads the marker off the input the agent actually disclosed, so a call that
   * sent no arguments at all (`rawInput: {}`, normalized to null upstream —
   * routine on this transport) is simply not recognised as one, rather than
   * throwing on a property read.
   */
  private delegateLaunchEvents(toolCall: AcpToolCall): AgentEvent[] {
    const delegate = this.options.delegate;
    if (delegate === undefined) {
      return [];
    }
    const input = asRecord(toolCall.rawInput);
    if (
      input === null ||
      asString(input[delegate.launchMarker.key]) !== delegate.launchMarker.value
    ) {
      return [];
    }
    // Per-TURN state on the driver, never on the adapter: one adapter instance
    // serves N concurrent turns under graph fan-out.
    this.delegateToolCalls.add(toolCall.toolCallId);
    return [
      this.delegateEvent({
        id: toolCall.toolCallId,
        // Every fact is still unknown: this CLI's launch frame carries only the
        // tool's own name, and its title at that moment is the placeholder
        // `Task: Subagent task`. Announcing the anchor alone is the point — the
        // block exists and says "working" until the brief arrives.
        label: null,
        kind: null,
        prompt: null,
        model: null,
        durationMs: null,
      }),
    ];
  }

  /** This tool call launched a delegate whose result is the CLI's own accounting. */
  private isBookkeepingResult(toolCallId: string): boolean {
    return (
      this.options.delegate?.resultIsBookkeeping === true &&
      this.delegateToolCalls.has(toolCallId)
    );
  }

  /** One `subagent_info` row, with this protocol's steps reason stamped on. */
  private delegateEvent(facts: AcpDelegateFacts): AgentEvent {
    return {
      type: 'subagent_info',
      ...facts,
      stepsUnavailableReason:
        this.options.delegate?.stepsUnavailableReason ?? null,
      // This protocol reports no background lifecycle for a delegate, so it
      // claims nothing about one: null leaves the transcript's own reading (the
      // launching call returning) exactly as it was for every ACP agent.
      backgroundOpen: null,
    };
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
      // A vendor NOTIFICATION is fire-and-forget by definition — ignoring one
      // is a no-op, not a stall. Note that cursor's `cursor/*` extensions are
      // not these: every one observed on the wire carries a JSON-RPC `id` and
      // so arrives as a request (`onAgentRequest`), including the ones whose
      // outcome the agent then throws away.
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
        if (text === null) {
          return [];
        }
        // The ephemeral twin is `reasoning_delta`, NOT `thinking_progress`:
        // that event carries a token COUNT, which is claude's answer to
        // redacted thinking and cannot express text. Without a live twin here
        // a thinking stretch emitted nothing at all — `appendPending` buffers
        // until the block closes — so the transcript sat on `Working…` for the
        // whole of it while chunks were arriving. Measured on a real turn:
        // thought chunks at 16.8–20.0s and again at 32.1–34.4s, none of it on
        // screen until the block closed.
        return [
          ...this.appendPending('reasoning', text),
          { type: 'reasoning_delta', text },
        ];
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
          // A delegation announces itself twice: here, so the block opens while
          // the delegate is still working, and again with its brief when the
          // agent sends it. Emitted AFTER the tool call it anchors to, so a
          // consumer replaying in `seq` order has the row before the reference
          // to it.
          ...this.delegateLaunchEvents(toolCall),
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
            result: this.isBookkeepingResult(toolCall.toolCallId)
              ? // The pair still CLOSES — the block reads `completed` off the
                // result's existence — it just carries no body to frame as the
                // delegate's report.
                null
              : (toolCall.rawOutput ??
                (diffs.length > 0 ? { diffs } : (update.content ?? null))),
            isError: toolCall.status === 'failed',
          },
        ];
      }
      case 'available_commands_update': {
        // The session's invokable set for this cwd — feeds the composer's `/`
        // autocomplete. Useful during a replay too (it is current state, not
        // history), so it is deliberately outside the replay guard.
        //
        // The DESCRIPTION is read alongside the name because this transport is
        // the only place it exists: an ACP agent may have no on-disk convention
        // geniro can scan, and dropping the sentence left every row in the
        // popup a bare word. Verified against cursor-agent 2026.08.11-e8db854,
        // whose 27 entries all carry one.
        const commands = asArray(update.availableCommands)
          .map((entry) => {
            const record = asRecord(entry);
            const name = record ? asString(record.name) : null;
            return name === null || name.length === 0
              ? null
              : {
                  name,
                  description: record ? asString(record.description) : null,
                };
          })
          .filter(
            (command): command is AgentReportedCommand => command !== null,
          );
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
        // user_message_chunk (our own prompt echoed back — an IMPORT reads
        // those out of a `session/load` replay in `acp-sessions.ts` instead, at
        // creation time, so they land BELOW the first message the user sends
        // here), plan/plan_update, current_mode_update, config_option_update,
        // session_info_update — all real ACP updates this transcript does not
        // model.
        return [];
    }
  }
}
