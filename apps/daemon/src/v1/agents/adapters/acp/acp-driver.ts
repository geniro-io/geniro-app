import { asArray, asNumber, asRecord, asString } from '../../utils/json-util';
import type {
  AgentEvent,
  AgentReportedCommand,
  AgentTask,
  AgentTurnInput,
  AgentUsage,
  FollowUpMessage,
} from '../adapter.types';
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_PROTOCOL_VERSION,
  ACP_STOP_REASONS,
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
  decodeRequestId,
  encodeError,
  encodeNotification,
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
import type { AcpSession } from './acp-session';

/** What we sent, so the reply can be routed without a callback map. */
export type PendingKind =
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
  /**
   * Whether the LAUNCHING call's own return says the delegate goes on running
   * after it — read off that call's `rawOutput`, or null when this CLI says
   * nothing either way.
   *
   * The one fact that separates "the delegation was accepted" from "the work is
   * over", and without it a backgrounded delegate is indistinguishable from a
   * finished one: the call returns in a fifth of a second and carries the same
   * shape either way. MEASURED on cursor-agent 2026.08.11-e8db854 by asking for
   * a background delegate and watching the wire — `tool_call_update` completed
   * at +18.7s with `rawOutput: {durationMs: 203, isBackground: true}`, the turn
   * ended at +22.7s, and the delegate was still asking this client for shell
   * permissions at +89s. The `cursor/task` announcement carries no such field
   * (checked in the CLI's own `sendToolExtensionNotification`, which builds it
   * from the args and the duration alone), so `rawOutput` is the only carrier.
   *
   * This is the condition `cursor-acp.const.ts` wrote down as RE-CHECK IF —
   * "`isBackground: true` is ever seen" — and it has now been seen, on a real
   * thread: ten reviewers launched in the background, each block reading
   * `took 0s` under a green check while every one of them was still working.
   *
   * An adapter that declares none keeps the old reading, which is right for a
   * CLI whose launching call genuinely waits for its delegate.
   */
  readsBackgroundLaunch?: (rawOutput: unknown) => boolean | null;
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

/**
 * How one agent reports its OWN failure — for a CLI that reports it inside the
 * conversation instead of on the protocol.
 *
 * ACP has no channel for this, and it is not an oversight either side can fix
 * from here: `session/prompt` answers a stop reason, and a request that never
 * completed still has to answer something. A CLI is therefore free to catch its
 * own transport failure, write the sentence out as an
 * `agent_message_chunk`, and reply `end_turn` — which is exactly what
 * cursor-agent does (see `cursor-acp/utils/cursor-agent-failure.utils.ts` for
 * the catch block it does it in). Nothing about that is visible to a client
 * reading the protocol correctly: the turn is a success carrying one more
 * paragraph of the agent's prose.
 *
 * So the recognition has to be the ADAPTER's, and this seam is the whole of
 * what the driver knows about it — one predicate over one chunk. An adapter
 * that declares none keeps the old behaviour, which is correct for an agent
 * whose failures reach the protocol.
 */
export interface AcpAgentFailureProtocol {
  /**
   * The failure this chunk reports, or null when it is the agent talking —
   * which is every chunk of a healthy turn, so this runs on all of them and
   * must be cheap and heavily anchored.
   *
   * Returning the message rather than a boolean because the CLI's own framing
   * (leading blank lines, a prefix) is the adapter's to strip: the driver would
   * otherwise have to know where the sentence starts.
   */
  read(text: string): string | null;
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

/**
 * What is true of the AGENT for the whole process — the half of the old flat
 * `AcpDriverOptions` that does NOT change between turns.
 *
 * The split is the point. A kept process serves turn after turn, and everything
 * per-turn is rebuilt from that turn's own input ({@link AcpTurnOptions}), so
 * "per-turn" is the DEFAULT and session scope is the explicit exception. The
 * alternative — one long-lived object with a reset for each field that must not
 * survive — makes "remember to reset" the invariant, and the next field added
 * breaks it silently. Two of them were already sharp: `input` and the image
 * blocks read from it were fixed at construction, so a second turn would have
 * re-sent the first turn's attachments.
 */
export interface AcpSessionOptions {
  /** Advertised to the agent as `clientInfo`. */
  clientName: string;
  clientVersion: string;
  /**
   * Build the options for ONE turn from that turn's own input.
   *
   * A factory rather than a value, and REQUIRED rather than defaulted: every
   * per-turn field derives from the argument, so an adapter physically cannot
   * leave one closed over the first turn's input. A default that reused the
   * previous turn's object would reintroduce exactly the leak this shape exists
   * to make impossible.
   */
  turnOptions: (input: AgentTurnInput) => AcpTurnOptions;
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
   * How this agent reports its OWN failure inside the conversation, or absent
   * when its failures reach the protocol.
   */
  agentFailure?: AcpAgentFailureProtocol;
  /**
   * How full this agent's window is, read OFF-PROTOCOL — absent for an agent
   * that reports it on the wire, or not at all.
   *
   * No shipped ACP agent here has been observed accounting for its context on
   * the wire — none sends the `usage_update` the protocol defines, and a prompt
   * reply carries no window — so an ACP turn's meter has nothing of its own to
   * draw and the ring would sit empty for the life of the chat. A CLI can KEEP that
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
}

/**
 * What is true of ONE turn, rebuilt for each of them from that turn's own input.
 *
 * Every field here is derived from {@link input} by the adapter's
 * `AcpSessionOptions.turnOptions` factory, which is what makes a second turn on
 * a kept process carry its OWN prompt, attachments, model settings and approval
 * posture rather than the first turn's.
 */
export interface AcpTurnOptions {
  /** The turn being driven — prompt, cwd, resume id, MCP endpoint. */
  input: AgentTurnInput;
  /**
   * Resolve a permission request without the user. `null` surfaces an
   * `approval_request` event and parks the agent until a verdict arrives —
   * which is a capability the legacy `cursor-agent -p --force` path never had.
   *
   * Per TURN because the approval posture is: a chat switched from `acceptEdits`
   * back to `ask` between two messages must be gated on the second one.
   */
  autoDecide: (toolCall: AcpToolCall) => AutoDecision;
  /** Session mode to request after the session exists, when the agent offers it. */
  preferredModeId?: string | null;
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
 * The element the turn's instructions are wrapped in, and the sentence inside
 * it saying what they are.
 *
 * ACP has no system-prompt field, so these instructions arrive as part of the
 * USER's turn — and an agent answers what the user says. REPORTED, and then
 * reproduced end to end: a chat opened with `Hello!` got back a paragraph
 * beginning "Got it — I'll treat this as a **rich markdown chat transcript**,
 * not terminal output", listing the formats geniro had just described. The
 * conversation was then genuinely ABOUT geniro's preamble — its own title,
 * however derived, said so — because the preamble was the only substantial
 * thing in the turn. claude never had this: `--append-system-prompt` is out of
 * band, so there is nothing there for the model to reply to.
 *
 * A named element with a stated role is what puts it back out of band as far
 * as anything here can. Both halves matter: the tag is a boundary a model
 * recognises as structure rather than speech, and the sentence is what says
 * which kind of structure, since an unexplained tag is just more text.
 */
export const HOST_CONTEXT_TAG = 'host-context';
export const HOST_CONTEXT_NOTE =
  'The block below is not a message from the user and not a request. It describes the app you are running inside. Follow it, and do not reply to it, summarise it, or mention it.';

/**
 * How often a running turn re-reads its agent's off-protocol context source.
 *
 * A measurement rather than a round number: on a fresh cursor chat the store's
 * root blob was rewritten at 17.2s, 18.7s, 21.2s, 21.7s and 24.2s into the
 * opening turn — gaps of 0.5s to 2.5s — so a two-second floor lands close to
 * one reading per rewrite without asking a turn's every chunk for one. The read
 * itself is cheap (0.14ms, a 4KB SQLite open and a protobuf walk); what this
 * bounds is the socket emission each new figure costs every watching client.
 */
const CONTEXT_REREAD_MS = 2_000;

/**
 * Whether two readings say the same thing — the model included, since a turn
 * that switched models is reporting a different window even at an identical
 * count.
 */
function sameContextReading(
  a: AcpContextReading | null,
  b: AcpContextReading,
): boolean {
  return (
    a !== null &&
    a.usedTokens === b.usedTokens &&
    a.windowTokens === b.windowTokens &&
    a.model === b.model
  );
}

/**
 * Drives ONE ACP turn: the mode/model/parameter frames it opens with, its
 * `session/prompt`, the agent's `session/update` stream, its
 * `session/request_permission` round-trips, and finally the `session/prompt`
 * reply carrying the stop reason that ends the turn.
 *
 * **Genuinely one instance per turn.** It holds the accumulated usage, the
 * parked permission requests, the open text block, the delegate bookkeeping and
 * this turn's own input — none of which may leak into the next turn on a kept
 * process, and none of which may be shared across the N concurrent turns one
 * adapter instance serves. What OUTLIVES a turn — the transport, the request-id
 * counter, the negotiated capabilities, the session id — lives on the
 * {@link AcpSession} this is constructed against, which is the whole of the
 * split: a field added here is per-turn by default, and making one survive is a
 * deliberate move to the other class.
 *
 * Everything inbound is read through the defensive `json-util` accessors: an
 * unrecognized notification, an unparseable update, or a field that moved
 * between CLI versions degrades to "no event", never to a thrown turn.
 */
export class AcpTurnDriver {
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
  /**
   * THIS turn's attachments, read off disk when the turn opens.
   *
   * The sharpest of the fields the session/turn split exists for: it was read
   * once at construction from an `input` that never changed, so on a kept
   * process every later turn would have re-sent the first turn's screenshots.
   */
  private readonly imageBlocks: AcpImageBlock[];
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
  /**
   * When the last reading was taken, so the mid-turn re-read is bounded by the
   * clock rather than by how chatty the agent happens to be.
   */
  private lastContextReadAt = 0;
  private readonly textChunks: string[] = [];
  /**
   * The failure this agent reported about ITSELF, kept until the stop reason
   * that would otherwise call the turn a success.
   *
   * Per-turn state, so it belongs to the driver rather than the adapter: one
   * adapter instance drives N concurrent turns under graph fan-out. It has to
   * be state at all because the two halves arrive apart — the sentence in a
   * message chunk, the ending in the prompt reply — and it is the ENDING that
   * is wrong, so the sentence has to outlive its own notification to correct
   * it. See {@link AcpAgentFailureProtocol}.
   */
  private agentFailure: string | null = null;
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
  /** One notice per turn for unimplemented agent→client requests. */
  private warnedUnsupportedRequest = false;
  /** The model asked for, so a refusal can name it. */
  private requestedModelId: string | null = null;
  /** The last `<id>=<value>` parameter asked for, so a refusal can name it. */
  private requestedParameter: string | null = null;

  /**
   * @param session the process this turn runs on, and the owner of everything
   *   that outlives it.
   * @param options THIS turn's own options, built by
   *   `AcpSessionOptions.turnOptions` from this turn's input.
   */
  constructor(
    private readonly session: AcpSession,
    private readonly options: AcpTurnOptions,
  ) {
    // Read here rather than lazily, so an unreadable attachment fails the turn
    // at its own opening — where `AgentAdapter.start`'s synchronous try and
    // `AcpSession.openTurn`'s catch each turn it into one honest `error` event
    // — instead of throwing out of the message pump mid-handshake.
    this.imageBlocks = buildAcpImageBlocks(options.input.images);
  }

  /**
   * Open this turn on a session that is ALREADY established — every message of
   * a chat after the first.
   *
   * The counterpart of the `session/new` reply's own tail, and literally the
   * same code ({@link beginTurn}): a later turn re-applies the mode, the model
   * and the model parameters before sending its prompt, because none of those
   * are argv on this transport and only `model` and `effort` are part of
   * `AgentAdapter.sessionKey` — a context window or a `fast` toggle changed
   * between two messages would otherwise silently keep the first turn's value
   * for the life of the conversation.
   *
   * The stored session reply is what it reads them against. Modes, models and
   * config options are properties of the SESSION, restated by no later frame,
   * so turn 1's reply is still the agent's own answer about what it offers.
   */
  openOnLiveSession(): AgentEvent[] {
    const events: AgentEvent[] = [];
    this.beginTurn(this.session.lastSessionReply, events);
    return events;
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
    if (this.session.parkedQuestions.has(id)) {
      const params = this.session.parkedQuestions.get(id);
      this.session.parkedQuestions.delete(id);
      const question = this.session.options.question;
      if (requestId === null || question === undefined) {
        return undefined;
      }
      return encodeResult(
        requestId,
        question.encodeReply(params, allow, updatedInput),
      );
    }
    const options = this.session.parkedPermissions.get(id);
    if (requestId === null || options === undefined) {
      return undefined;
    }
    this.session.parkedPermissions.delete(id);
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

  // --- inbound ------------------------------------------------------------

  onReply(kind: PendingKind, result: unknown, id: JsonRpcId): AgentEvent[] {
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
        // arrives as an error reply instead (see onErrorReply). What it DOES
        // need is recording: the mode outlives this turn, so the next one has
        // to know where the session actually is before deciding whether to move
        // it — see {@link pickMode}. Only on acceptance, so a refused frame
        // cannot make the client believe a mode it never got.
        this.session.currentModeId = this.requestedModeId;
        return [];
      case 'set_model':
        // Same contract as `set_mode` above: silence on acceptance, a `notice`
        // from `onErrorReply` on a refusal — and recorded for the same reason,
        // since this reply is the ONLY signal that the agent took the model.
        // The offers check in `applyModel` cannot stand in for it: that reads
        // the vocabulary the agent ENUMERATED, and a refusal is reachable past
        // it, so a model that passed it can still be running on something else.
        this.session.currentModelId = this.requestedModelId;
        return [];
      case 'set_model_parameter':
        // Silent too — but it may be the frame the prompt is waiting on.
        return this.releasePrompt(id);
      case 'prompt':
        return this.onPromptComplete(result, id);
    }
  }

  onErrorReply(
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
      this.session.resumed = false;
      this.replayStartedAt = null;
      this.replayedUpdates = 0;
      this.session.request(
        ACP_AGENT_METHODS.sessionNew,
        {
          cwd: this.options.input.cwd,
          mcpServers: this.session.grantedMcpServers,
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
    this.session.capabilities = {
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
    this.session.grantedMcpServers = mcpServers;
    if (notice) {
      events.push({ type: 'notice', message: notice });
    }

    const resumeId = this.options.input.resumeSessionId?.trim();
    if (resumeId && this.session.capabilities.loadSession) {
      this.replaying = true;
      this.session.resumed = true;
      this.replayStartedAt = Date.now();
      this.session.request(
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
          'this agent cannot resume a conversation — the turn starts fresh, without the earlier messages',
      });
    }
    this.session.request(
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
    if (!this.session.capabilities.mcpHttp) {
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
    this.session.sessionId =
      (root ? asString(root.sessionId) : null) ??
      this.options.input.resumeSessionId?.trim() ??
      null;
    this.replaying = false;
    this.reportReplayCost();

    if (this.session.sessionId === null) {
      return [
        {
          type: 'error',
          message: 'acp session failed: the agent returned no session id',
        },
      ];
    }
    events.push({ type: 'session', sessionId: this.session.sessionId });
    // The mode the agent OPENED in, and therefore the one a later turn that
    // wants no particular mode has to ask to be put back into.
    const openedIn = asString(asRecord(root?.modes)?.currentModeId);
    this.session.defaultModeId = openedIn;
    this.session.currentModeId = openedIn;
    // KEPT for the turns after this one. Modes, models and config options are
    // properties of the session and are restated by no later frame, so this
    // reply stays the agent's own answer about what it offers for as long as
    // the process lives — see {@link openOnLiveSession}.
    this.session.lastSessionReply = root;
    this.beginTurn(root, events);
    return events;
  }

  /**
   * Put the agent on THIS turn's settings and send its prompt — the mode, the
   * model, the model's own parameters, then `session/prompt`.
   *
   * Shared by the two ways a turn opens (the `session/new`|`session/load` reply
   * for the first, {@link openOnLiveSession} for every later one) precisely so
   * they cannot drift: a later turn that skipped any of these would run under
   * the settings of the turn that happened to spawn the process.
   */
  private beginTurn(
    root: Record<string, unknown> | null,
    events: AgentEvent[],
  ): void {
    // Before the prompt goes out, so a RESUMED conversation shows what it
    // already holds for the whole of this turn instead of only once the turn
    // ends. A fresh session has written nothing yet and reads as no figure,
    // which is the honest answer for a window that holds nothing.
    this.emitContextReading(events);

    const modeId = this.pickMode(root);
    if (modeId !== null) {
      this.requestedModeId = modeId;
      this.session.request(
        ACP_AGENT_METHODS.sessionSetMode,
        { sessionId: this.session.sessionId, modeId },
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
        message: this.session.resumed
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
      return;
    }
    this.sendPrompt(events);
  }

  /** The turn's prompt — composed once, whether it goes now or after a reply. */
  private sendPrompt(events: AgentEvent[]): void {
    if (this.session.sessionId === null) {
      return;
    }
    const id = this.session.sendRequest(
      ACP_AGENT_METHODS.sessionPrompt,
      {
        sessionId: this.session.sessionId,
        prompt: this.composePromptBlocks(events),
      },
      'prompt',
      events,
    );
    if (id !== null) {
      this.latestPromptId = id;
      // Recorded on the WRITE, not on composing it: a prompt that never left is
      // a prompt the agent has not been told the preamble by, and marking it
      // sent there would withhold it from the retry.
      this.session.preambleSent = true;
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
    if (this.session.sessionId === null || this.promptHeld) {
      return false;
    }
    const events: AgentEvent[] = [];
    const images = buildAcpImageBlocks(message.images);
    // Gated on the agent's OWN advertised capability, the same check the turn's
    // opening prompt passes through: an unadvertised image block earns an error
    // reply, which here would lose the message rather than merely the picture.
    const withImages =
      images.length > 0 && this.session.capabilities.promptImage;
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
    const id = this.session.sendRequest(
      ACP_AGENT_METHODS.sessionPrompt,
      { sessionId: this.session.sessionId, prompt: blocks },
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
      this.session.emit(event);
    }
    return sent;
  }

  /**
   * The in-protocol "stop what you are doing" — `TurnDriver.buildInterruptPayload`.
   *
   * ACP's own answer, and the ONLY correct one now that the process outlives its
   * turn: `session/cancel` is a NOTIFICATION (no id, no reply), and the spec
   * requires the agent to answer the pending `session/prompt` with stop reason
   * `cancelled`, which is what actually settles the turn. `spawn-cli` arms a
   * short deadline behind the write and kills the group only if that reply never
   * comes, so an agent that ignores the frame still stops.
   *
   * Killing instead is what it used to do and is no longer acceptable: the group
   * holds the whole conversation and every delegate still out, so Stop on one
   * turn would destroy the chat. It is also why this is a DRIVER hook rather
   * than an adapter one — the frame names the session id, which only the driver
   * holds.
   *
   * Undefined before the session exists: there is nothing to cancel, and
   * `spawn-cli` falls back to the group kill, which is the right answer for a
   * process that has not yet opened a conversation to lose.
   */
  buildInterruptPayload(): string | undefined {
    return this.session.sessionId === null
      ? undefined
      : encodeNotification(ACP_AGENT_METHODS.sessionCancel, {
          sessionId: this.session.sessionId,
        });
  }

  /**
   * A frame this turn sent has gone unanswered past its deadline.
   *
   * The SAME shape a refusal takes (`onErrorReply`), and deliberately so: the
   * setting did not apply either way, and what a turn must not do is sit behind
   * a frame that is never going to land. So a notice says what was lost and the
   * prompt is released — never a teardown, since the session is perfectly able
   * to run this turn on whatever the agent kept, which is what it would have
   * done had the frame never been sent at all.
   */
  onRequestDeadline(
    id: JsonRpcId,
    kind: PendingKind,
    ms: number,
  ): AgentEvent[] {
    // Only a frame still HOLDING the prompt has anything to rescue, and the two
    // conditions are not the same question. Every parameter goes out under the
    // one `set_model_parameter` kind while only an `applyBeforePrompt` one is
    // added to `promptBlockers` (see `applyModelParameters`), so most frames
    // here never blocked anything; and a turn whose prompt has already gone out
    // has run on regardless of what this reply would have said.
    //
    // Speaking anyway is worse than silence: an event emitted once the turn has
    // settled reaches the off-turn handler, which reads a `notice` as the run
    // WORKING again — and since nothing terminal follows it, the badge stays
    // that way until the session closes.
    if (!this.promptHeld || !this.promptBlockers.has(id)) {
      return [];
    }
    const released = this.releasePrompt(id);
    // A release whose prompt did not actually go out means the TURN is gone —
    // the process was killed, or the pipe closed under it. Nothing here has a
    // reader in that case, and both halves would be untrue: the notice would
    // promise a turn that runs on, and the failed write's own error would
    // report a send nobody is waiting for. The session outlives its turns and
    // holds no settle signal, so this is what stands in for one — a prompt that
    // still writes is the evidence the turn is there to be told.
    if (released.some((event) => event.type === 'error')) {
      return [];
    }
    return [
      {
        type: 'notice',
        severity: 'warning',
        message: `the agent did not answer '${kind}' within ${Math.round(ms / 1000)}s — this turn runs on its own settings`,
      },
      ...released,
    ];
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
    if (this.session.sessionId === null) {
      return;
    }
    // The adapter's split when it supplied one, else the stored id verbatim.
    const selection = this.options.modelSelection ?? {
      model: this.options.input.model ?? null,
      parameters: [],
    };
    const wanted = selection.model?.trim();
    // The agent's own statement SEEDS the field, and only while it is still
    // unset. Every later turn on a kept process is handed the STORED
    // `session/new` reply, which names the model the session was CREATED with —
    // so re-seeding from it once per turn would undo a switch an earlier turn
    // had confirmed. Same rule `pickMode` states for the mode: the reply says
    // where the session started, never where it is now.
    const announced = readAcpCurrentModelId(sessionResult);
    if (
      this.session.currentModelId === null &&
      announced !== null &&
      announced !== ''
    ) {
      this.session.currentModelId = announced;
    }
    // The requested model is ANNOUNCED, never RECORDED. `currentModelId` holds
    // what the agent CONFIRMED — the `set_model` acceptance arm in `onReply` is
    // what moves it — while `turn_model` reports what this turn asked to run
    // as. The two differ exactly while a switch is unconfirmed, and that
    // difference is load-bearing downstream: it is what
    // `PartialStreamService.rememberWindow`'s anti-poisoning guard compares.
    // Writing `wanted` here would collapse both of that guard's operands onto
    // this one field — cursor's context reading names no model, so a window's
    // own label falls back to it too — leaving the guard comparing a value
    // against itself, unable to fire, and filing a refused model's window under
    // the requested one.
    const runningAs = wanted ? wanted : this.session.currentModelId;
    if (runningAs !== null && runningAs !== '') {
      events.push({ type: 'turn_model', model: runningAs });
    }
    // Parameters are applied EVEN WHEN the model needs no change — they are a
    // separate axis, and a run that keeps the agent's current model while
    // choosing a different effort is the ordinary case for a chat left on
    // "default model". Both early returns below therefore fall through to them.
    // Against what the session is ON now, not against the reply — which on any
    // turn but the first describes a model an earlier turn may have switched
    // away from, so comparing with it re-sends the frame every turn.
    if (!wanted || this.session.currentModelId === wanted) {
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
      this.session.request(
        ACP_AGENT_METHODS.sessionSetConfigOption,
        { sessionId: this.session.sessionId, configId, value: wanted },
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
    this.session.request(
      ACP_AGENT_METHODS.sessionSetModel,
      { sessionId: this.session.sessionId, modelId: wanted },
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
    if (this.session.sessionId === null) {
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
      const id = this.session.sendRequest(
        ACP_AGENT_METHODS.sessionSetConfigOption,
        {
          sessionId: this.session.sessionId,
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
    if (!this.session.capabilities.promptImage) {
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
    this.session.options.logger?.debug?.(
      `acp session/load replayed ${this.replayedUpdates} update(s) in ${elapsedMs}ms before this turn's prompt could be sent`,
    );
  }

  /**
   * ACP carries no system-prompt parameter, so the turn's instructions ride the
   * prompt text. WHICH instructions is the base adapter's rule, not this
   * driver's — see `AgentAdapter.composeSystemPrompt`; this only supplies the
   * two facts the protocol knows: whether the call tools ended up registered,
   * and whether the host preamble still needs saying.
   *
   * **The user's own words come FIRST, and the instructions follow inside a
   * named block — both halves are fixes, and neither works alone.** See
   * {@link HOST_CONTEXT_TAG} for what the block is for. The ORDER is about the
   * name: a CLI names the conversation from its first prompt, and this text is
   * that prompt, so with the instructions leading cursor-agent named every
   * geniro chat after geniro's own preamble. Measured on 2026-08-25 against
   * "Explain in three sentences how a bloom filter works" — instructions first
   * gave `Markdown Not Terminal`, the user's sentence first gave `Bloom Filter
   * Explained` — with `Markdown Renderer Instructions` and `Markdown Display
   * Info` across the rest of the sidebar, and nothing on screen to suggest a
   * name the user never wrote came from a block they cannot see. Order alone
   * was not enough: a SHORT opening is still swamped, and `Hello!` came back
   * `Geniro Markdown Display`. Neither costs the instructions anything —
   * probed on the same build, an agent asked where its replies are displayed
   * still answered from the preamble ("Geniro's rich GFM chat transcript, and
   * no, remote HTTPS images cannot render"), which is the claim the preamble
   * exists to make.
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
    // The preamble goes out ONCE per session, and both halves of that condition
    // are the same fact seen from either side: a `session/load` has already
    // replayed it, and a turn on a KEPT process is adding to a conversation
    // this client has already put it in. Missing the second half is a
    // regression the session/turn split would otherwise introduce — with one
    // process per turn, `resumed` covered every case there was.
    const instructions = this.options.composeSystemPrompt(
      this.session.grantedMcpServers.length > 0,
      !this.session.resumed && !this.session.preambleSent,
    );
    if (instructions.length === 0) {
      return this.options.input.prompt;
    }
    return [
      this.options.input.prompt,
      `<${HOST_CONTEXT_TAG}>`,
      HOST_CONTEXT_NOTE,
      instructions,
      `</${HOST_CONTEXT_TAG}>`,
    ]
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
    // A turn that wants no particular mode wants the agent's OWN default, and
    // on a kept process that is something it has to ASK for. The mode is
    // session state the client sets and nothing resets, so `plan` set by turn 1
    // is still in force on turn 2 — which sent nothing at all here, there being
    // no mode to request, and left a chat the user had switched back to `auto`
    // running read-only under a composer chip and a run row that both said
    // `auto`. Unreachable while each turn was a fresh `session/new`.
    const wanted = this.options.preferredModeId ?? this.session.defaultModeId;
    if (!wanted) {
      return null;
    }
    const modes = sessionResult ? asRecord(sessionResult.modes) : null;
    if (!modes) {
      return null;
    }
    // Against what the session is in NOW, not against the reply — the reply is
    // the one the session OPENED with, so on turn 2 it describes a mode a
    // previous turn may have moved away from.
    if (this.session.currentModeId === wanted) {
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

    if (this.agentFailure !== null) {
      // The CLI told us the turn FAILED and then told us it ended normally.
      // The first statement is the true one, so the turn settles on an `error`
      // INSTEAD of a `turn_complete` — not as well as, or the run would settle
      // twice and the second reading would put the success badge back.
      //
      // What the agent said BEFORE it died is still flushed: the failure came
      // at the end of real work, and a transcript that dropped it would hide
      // the part the user can act on. What is dropped is the failure's own
      // usage and `finalText` — a turn that produced no answer has none, and
      // publishing a `finalText` here would hand a downstream graph node the
      // transport error as this node's output.
      const message = this.agentFailure;
      this.agentFailure = null;
      return [...this.flushPending(), { type: 'error', message }];
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
   *
   * `everyMs` is what separates the turn's two BOUNDARY readings from the ones
   * taken WHILE it runs. A boundary reading passes 0 and is unconditional; a
   * mid-turn one names the interval below which the source is not re-read and
   * an unmoved figure is not re-published. See {@link CONTEXT_REREAD_MS}.
   */
  private emitContextReading(events: AgentEvent[], everyMs = 0): void {
    const read = this.session.options.readContext;
    if (read === undefined || this.session.sessionId === null) {
      return;
    }
    const now = Date.now();
    if (everyMs > 0 && now - this.lastContextReadAt < everyMs) {
      return;
    }
    this.lastContextReadAt = now;
    let reading: AcpContextReading | null;
    try {
      reading = read(this.session.sessionId);
    } catch (err) {
      this.session.options.logger?.warn(
        `acp context reading failed (the turn is unaffected): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (reading === null || reading.usedTokens === null) {
      return;
    }
    // The store is rewritten several times a turn and the figure does not move
    // with every rewrite, so a mid-turn reading equal to the one already on
    // screen is traffic rather than news — each one is a socket emission to
    // every client watching the run. The BOUNDARY readings are exempt: the one
    // before `turn_complete` is what the settle path is built around, and
    // suppressing it would make the durable half depend on whether the last
    // mid-turn read happened to catch the same number.
    if (everyMs > 0 && sameContextReading(this.contextReading, reading)) {
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
      // The denominator comes from the off-protocol reading because no shipped
      // ACP agent here has been observed SENDING a window, not because the
      // protocol has none: `usage_update` defines `size` as required beside
      // `used`, and the arm below reads `used` alone — this file's own spec
      // builds a frame carrying `size: 200_000` and pins it discarded. Absent a
      // reading, the consumer shows the count with no denominator rather than
      // this client claiming a window no agent stated.
      contextWindowTokens: this.contextReading?.windowTokens ?? null,
      // From the same reading as the window and never on its own: a model id
      // here is a label ON that denominator, so one without the other names
      // something no figure is being measured against.
      contextModel:
        this.contextReading?.windowTokens == null
          ? null
          : // The reading's own name when it carries one; otherwise the model
            // the AGENT said it was running as. cursor's session store records
            // a full breakdown and names no model at all, so without the
            // fallback every window this transport measures is unattributable —
            // and a figure nobody can file is a figure the next turn cannot
            // reuse. The `windowTokens == null` guard above is untouched: a
            // model id here is still a label ON a denominator, never a name
            // offered with nothing being measured.
            (this.contextReading.model ?? this.session.currentModelId),
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

  onAgentRequest(id: JsonRpcId, method: string, params: unknown): AgentEvent[] {
    if (method === ACP_CLIENT_METHODS.sessionRequestPermission) {
      return this.onPermissionRequest(id, params);
    }
    const question = this.session.options.question;
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
      this.session.options.logger?.warn(
        `acp: ${method} arrived in an unrecognized shape — declined rather than shown as a question`,
      );
    }
    const delegate = this.session.options.delegate;
    if (delegate !== undefined && method === delegate.method) {
      const facts = delegate.read(params);
      if (facts !== null) {
        // ANSWERED, not declined. The agent discards the outcome either way, so
        // this changes nothing about the turn — what it changes is that the
        // delegate's brief, type, model and duration reach the transcript
        // instead of being refused and dropped.
        this.session.reply(id, {});
        return [this.delegateEvent(facts)];
      }
      this.session.options.logger?.warn(
        `acp: ${method} arrived in an unrecognized shape — declined rather than recorded as a sub-agent`,
      );
    }
    const todos = this.session.options.todos;
    if (todos !== undefined && method === todos.method) {
      const update = todos.read(params);
      if (update !== null) {
        // ANSWERED. Like the delegate announcement, the agent discards the
        // outcome either way, so this changes nothing about the turn — what it
        // changes is that the task list reaches the transcript instead of being
        // refused and dropped, which is what the user could not see.
        this.session.reply(id, {});
        return [{ type: 'task_list', ...update }];
      }
      this.session.options.logger?.warn(
        `acp: ${method} arrived in an unrecognized shape — declined rather than recorded as a task list`,
      );
    }
    // Everything else is a client capability we deliberately did not advertise
    // (`fs/*`, `terminal/*`) or a vendor extension we don't implement. A
    // blocking request MUST be answered or the agent parks forever, so refuse
    // it in-protocol — and say so once, since a refused extension can change
    // what the agent is able to do this turn.
    if (
      !this.session.write(
        encodeError(
          id,
          JSONRPC_METHOD_NOT_FOUND,
          `${method} is not implemented by this client`,
        ),
      )
    ) {
      this.session.options.logger?.warn(
        `acp: dropped the error reply to ${method}${this.session.writeFailure()}`,
      );
    }
    if (this.session.options.declinedWithoutNotice?.includes(method) === true) {
      // A refusal its own agent absorbs. The notice above is a per-TURN
      // budget of one, so narrating a harmless refusal does not merely add
      // noise — it spends the slot, and a consequential refusal later in the
      // same turn then goes unmentioned. Measured: an ordinary planning turn
      // on cursor-agent 2026.08.04 sends `cursor/update_todos`, which would
      // have burnt it. Still recorded, on the debug channel.
      this.session.options.logger?.debug?.(
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
    this.session.parkedQuestions.set(encodedId, params);
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
    const delegate = this.session.options.delegate;
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
    this.session.delegateToolCalls.add(toolCall.toolCallId);
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
      this.session.options.delegate?.resultIsBookkeeping === true &&
      this.session.delegateToolCalls.has(toolCallId)
    );
  }

  /**
   * The `subagent_info` saying this delegate is still out, when the launching
   * call's return said so — and nothing at all otherwise.
   *
   * Recording it is what makes {@link delegateEvent} drop the duration: the
   * announcement that follows carries the LAUNCH's milliseconds (198–408ms
   * across the ten delegates on the reported thread), and a block reading
   * `took 0s` states, about work that runs for minutes, a figure that measures
   * how long it took to ask for it.
   */
  private delegateBackgroundEvents(toolCall: AcpToolCall): AgentEvent[] {
    const reads = this.session.options.delegate?.readsBackgroundLaunch;
    if (
      reads === undefined ||
      !this.session.delegateToolCalls.has(toolCall.toolCallId)
    ) {
      return [];
    }
    if (reads(toolCall.rawOutput) !== true) {
      return [];
    }
    this.session.backgroundDelegates.add(toolCall.toolCallId);
    return [
      this.delegateEvent({
        id: toolCall.toolCallId,
        label: null,
        kind: null,
        prompt: null,
        model: null,
        durationMs: null,
      }),
    ];
  }

  /** One `subagent_info` row, with this protocol's steps reason stamped on. */
  private delegateEvent(facts: AcpDelegateFacts): AgentEvent {
    // A delegate the CLI said outlives its launching call: its announcement's
    // duration measured the LAUNCH, so it is dropped rather than published as
    // the delegate's own. Null cannot overwrite a figure under the merge rule,
    // so a later announcement carrying a real one still wins.
    const background = this.session.backgroundDelegates.has(facts.id);
    return {
      type: 'subagent_info',
      ...facts,
      ...(background ? { durationMs: null } : {}),
      // This protocol's delegate frame carries a duration and nothing else it
      // spent — measured on cursor's `cursor/task`, whose result is
      // `{durationMs, isBackground}` — so the figures are declared absent
      // rather than left off, which is what keeps the merge rule safe: a null
      // here cannot overwrite a value some other announcement gave.
      tokens: null,
      toolUses: null,
      // And with no tokens at all there is no breakdown to bill and nothing to
      // price. The cost derivation needs a per-kind split and a model name,
      // both of which this protocol withholds — so an ACP delegate reports its
      // duration and no money, which is what the reader should see.
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costUsd: null,
      // Declared absent for the same reason, and it is the honest answer: this
      // protocol's delegate frame says a delegate ran and how long for, never
      // how it ended. A guessed `completed` here would put a green check on a
      // delegate nobody reported the fate of.
      backgroundOutcome: null,
      stepsUnavailableReason:
        this.session.options.delegate?.stepsUnavailableReason ?? null,
      // Null unless the launching call's own return said the work outlives it,
      // which is the ONE thing this protocol reports about a delegate's
      // lifecycle. Null leaves the transcript's own reading (the launching call
      // returning) exactly as it was for every ACP agent; true withdraws it,
      // because a call that returned in 203ms did not wait for anything.
      //
      // It is never set FALSE here. False would mean "the CLI told us the work
      // is over", which this protocol has no frame for — nothing announces a
      // background delegate's ending on this wire, measured across 70s of
      // listening past the turn's own end.
      backgroundOpen: background ? true : null,
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
      this.session.reply(id, {
        outcome:
          optionId === null
            ? { outcome: 'cancelled' }
            : { outcome: 'selected', optionId },
      });
      return [];
    }

    const encodedId = encodeRequestId(id);
    this.session.parkedPermissions.set(encodedId, options);
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
        toolCall.name === ''
          ? (this.session.toolNames.get(id) ?? '')
          : toolCall.name,
      kind: toolCall.kind ?? this.session.toolKinds.get(id) ?? null,
      rawInput: toolCall.rawInput ?? this.session.toolInputs.get(id) ?? null,
    };
  }

  onNotification(method: string, params: unknown): AgentEvent[] {
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
    const events = this.onSessionUpdate(asString(update.sessionUpdate), update);
    // The turn's THIRD reading moment, and the one a first turn depends on.
    // The other two are boundaries: the session reply, where a conversation
    // the agent has never held has written nothing to read, and the settle.
    // So a brand-new chat's ring stayed empty for the whole of its opening
    // turn and filled only as that turn ended — reported as a chat that "still
    // hadn't loaded any context, and loaded it only later". Measured on a
    // fresh cursor chat (2026-08-25): the store held a complete reading of
    // 47,221 of 272,000 at 18.2s and went on moving, while the turn ran for
    // considerably longer. Notifications are the carrier because a turn that
    // is working always has them and one that is not has nothing worth
    // re-reading for; during a `session/load` replay `sessionId` is not yet
    // set, so the reading cannot fire against the previous turn's figures.
    this.emitContextReading(events, CONTEXT_REREAD_MS);
    return events;
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
        // This CLI reporting its own failure, which it does as an ordinary
        // message — see {@link AcpAgentFailureProtocol}. Held rather than
        // emitted: the terminal is what says a turn failed, and it has not
        // arrived yet. Deliberately NOT pushed onto `textChunks` either, so it
        // cannot become the turn's `finalText` — a downstream graph node
        // consuming "the answer" must not be handed the transport error as one.
        const failure = this.session.options.agentFailure?.read(text) ?? null;
        if (failure !== null) {
          this.agentFailure = failure;
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
        this.session.toolNames.set(toolCall.toolCallId, toolCall.name);
        if (toolCall.kind !== null) {
          this.session.toolKinds.set(toolCall.toolCallId, toolCall.kind);
        }
        if (toolCall.rawInput !== null) {
          this.session.toolInputs.set(toolCall.toolCallId, toolCall.rawInput);
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
              this.session.toolNames.get(toolCall.toolCallId) ??
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
          // …and, when this call launched a delegate that OUTLIVES it, the row
          // that says so. It rides the settled launching call because that is
          // the only frame carrying the flag, and it is emitted here rather
          // than folded into the announcement below because the announcement is
          // fire-and-forget on the agent's side — a delegate whose `cursor/task`
          // never arrived would otherwise be recorded as finished.
          ...this.delegateBackgroundEvents(toolCall),
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
      case 'current_mode_update': {
        // The agent moving itself between modes, which is the ONLY channel that
        // reports one: `set_mode`'s reply covers a change this client asked for
        // and nothing else. Recorded because the mode outlives the turn —
        // `pickMode` decides whether the next turn needs a frame at all by
        // comparing against where the session actually IS, so a mode changed
        // behind our back leaves it re-sending one that is already applied, or
        // skipping one it needed. It draws no transcript row: this is session
        // state, not something the agent said.
        const mode = asString(update.currentModeId);
        if (mode) {
          this.session.currentModeId = mode;
        }
        return [];
      }
      default:
        // user_message_chunk (our own prompt echoed back — an IMPORT reads
        // those out of a `session/load` replay in `acp-sessions.ts` instead, at
        // creation time, so they land BELOW the first message the user sends
        // here), plan/plan_update, config_option_update, session_info_update —
        // all real ACP updates this transcript does not model.
        return [];
    }
  }
}
