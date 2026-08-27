import type { ChildProcess } from 'node:child_process';

import type { AgentKind } from '../../runs/runs.types';
import type { ClaudeModesCapability } from '../chat.types';
import type { SessionAsk } from '../utils/spawn-cli';

// ── Geniro's own MCP server (agent-to-agent calls) ──────────────────────────
// The two names that identify OUR server and OUR tools inside a CLI's config
// file. They live in the adapter contract because WRITING that file is an
// adapter's job — claude's per-turn `--mcp-config` and cursor's
// `.cursor/mcp.json` merge both spell them — and a name two adapters must
// agree on cannot be owned by a module that imports this one.

/**
 * The name geniro's own MCP server is published under, in EVERY CLI's config:
 * claude's per-turn `--mcp-config` file and the `.cursor/mcp.json` entry
 * merged for a cursor turn. It belongs to us, not to either CLI — spelling it
 * twice is how the two configs would silently name different servers.
 * A foreign entry found under this key is a conflict, never ours to overwrite.
 */
export const GENIRO_MCP_SERVER_KEY = 'geniro';

/**
 * The tool names the per-run MCP endpoint serves. The cursor entry
 * auto-approves exactly these (never `--approve-mcps`, which would
 * blanket-approve the user's other servers too), so the trust expansion stays
 * bounded to what geniro itself publishes.
 */
export const GENIRO_MCP_CALL_TOOLS = [
  'call_agent',
  'await_agent',
  'answer_agent',
] as const;

/**
 * What ONE unit of background work consumed, as its CLI reported it when the
 * unit settled.
 *
 * Deliberately not {@link AgentUsage}, which is a TURN's accounting: this is a
 * flat total for a piece of work that ran inside a turn, and the two overlap in
 * one field only. Filling out the turn shape here would mean publishing a dozen
 * nulls no CLI has ever answered for a delegate — and the one figure it would
 * imply is available, `costUsd`, is exactly the one that is not (see
 * `subagent_info.tokens`).
 *
 * Every field nullable on the usual terms: a CLI reports what it reports.
 */
/**
 * How a unit of background work ENDED, in this app's own vocabulary rather than
 * any CLI's.
 *
 * The words are the transcript block's own (`chats/transcript-groups.ts`
 * `subagentBlockStatus`), so a CLI's spelling is translated once, in its
 * adapter, and no consumer downstream has to learn another vendor's list.
 * Claude alone spells the same outcome two ways on its two terminal channels
 * (`killed` on one, `stopped` on the other, measured for one task in one run),
 * which is why translating at the read site is the only place it can be done
 * once.
 */
export type BackgroundUnitOutcome = 'completed' | 'failed' | 'stopped';

export interface BackgroundUnitUsage {
  /** Every token the unit spent, prompt and completion together. */
  tokens: number | null;
  /** How many tool calls it made. */
  toolUses: number | null;
  /** How long it ran, as the CLI measured it. */
  durationMs: number | null;
}

/**
 * Token/cost accounting for a completed turn. Fields are nullable because not
 * every CLI version reports every figure — the defensive mappers fill what the
 * stream provides and leave the rest null.
 */
export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * Of the turn's billed input, how much was READ from the prompt cache and
   * how much was WRITTEN to it.
   *
   * The pair is the whole point and neither half is useful alone: on a
   * conversation past its first turn nearly the entire prompt is a cache read
   * (billed at a tenth), so `inputTokens` on its own — 2, on a turn that sent
   * 37,000 — reads as though almost nothing was sent. Together they are what
   * makes the cost figure explicable, which is the question a session-metrics
   * readout is opened to answer.
   *
   * Cumulative across the turn's requests, like {@link inputTokens} beside
   * them, and NOT a measure of context — that is {@link contextTokens}, and
   * the distinction is the one `claude-usage.utils.ts` exists to keep.
   */
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /**
   * Of {@link outputTokens}, how many were spent thinking rather than on the
   * answer. Null for a CLI that does not break its output down — never 0,
   * which is a real reading meaning "this turn did not think".
   */
  thinkingTokens: number | null;
  /**
   * How full the window is NOW — the prompt of the turn's LAST request, which
   * is the whole conversation as the model last saw it.
   *
   * Per-request, never a turn total: a turn re-sends the conversation once per
   * tool call, so adding those up measures work done, not context held (see
   * `claude/utils/claude-usage.utils.ts`). Cache traffic counts — on a resumed session it
   * IS the context — so a CLI that breaks it out reports input + cache-creation
   * + cache-read, and one that doesn't reports its plain input count.
   */
  contextTokens: number | null;
  /**
   * The window that context is measured against, as the CLI reports it for the
   * model it actually ran (claude: 1M for `claude-opus-5[1m]`, 200k for the
   * rest). Null when the CLI says nothing — the consumer then shows the count
   * with no denominator rather than claiming a window nobody confirmed.
   */
  contextWindowTokens: number | null;
  /**
   * WHICH model {@link contextWindowTokens} describes, when the CLI named one.
   *
   * A turn can touch more than one model — a small one runs side errands, and a
   * turn can fall back — so the window belongs to a specific model rather than
   * to the turn. Reported so a consumer caching windows per model can tell that
   * the figure describes the model the turn announced, and decline to file a
   * fallback model's window under the requested one.
   */
  contextModel: string | null;
  costUsd: number | null;
  /**
   * How long the turn took, as the CLI ITSELF measured it.
   *
   * The CLI's own figure and not a wall clock, which is the whole reason it is
   * an adapter fact rather than something the daemon times: it measures the
   * agent WORKING, and so excludes both of the waits geniro puts around a turn
   * — the first-prompt MCP-readiness hold (up to 15s, see
   * `claude-mcp-ready.utils.ts`) and any stretch parked on an approval card,
   * which is a human being timed. A turn blocked half an hour on a question
   * reports the seconds of work here, not the half hour.
   *
   * Null for a CLI that reports none, and the consumer then measures the wall
   * clock itself rather than showing nothing — the fallback is deliberately
   * NOT computed here, because a daemon-side timer would silently displace the
   * better number for every CLI that does report one.
   *
   * Probed live on claude 2.1.x (2026-08-14): the `result` line carries
   * `duration_ms` 7618 beside `duration_api_ms` 7176, `ttft_ms`,
   * `time_to_request_ms` and `num_turns`. Every one of those was being dropped.
   */
  durationMs: number | null;
  /**
   * Of {@link durationMs}, how much was spent waiting on the model's API.
   *
   * The remainder is the CLI's own work — running tools, reading files, its own
   * scaffolding — so the pair is what separates "the model was slow" from "the
   * agent did a lot". Null whenever the CLI reports no such split; ACP reports
   * neither figure (see `AcpTurnDriver.buildUsage`).
   *
   * **It can EXCEED {@link durationMs}, and a consumer must expect that.**
   * Measured 2026-08-14 on a two-turn chat over one kept session: turn 1 came
   * back `duration_ms` 3007 / `duration_api_ms` 2504, and turn 2 `duration_ms`
   * 2562 / `duration_api_ms` 4633. The CLI is not reporting a subdivision of one
   * interval on a resumed process, so the subtraction is only meaningful when it
   * lands non-negative — the renderer's tooltip withholds the split entirely
   * rather than printing a negative "own work" figure.
   */
  apiMs: number | null;
}

// ── What the window currently HOLDS ─────────────────────────────────────────
//
// {@link AgentUsage} answers "what did that turn cost"; everything below
// answers "what is in the window right now, and what put it there". They are
// different questions with different sources: usage is read off a turn's own
// result line, while this is ASKED of a live process (see
// `AgentSession.readContextUsage`) and so has no turn attached to it at all.

/**
 * Which of {@link AgentSessionReadInput}'s two channels a CLI's reading comes
 * from.
 *
 * `live-process` is a question put to a RUNNING agent over its own stdin
 * dialogue, so the reading exists only while the run holds a session (claude).
 * `session-store` is read off what the CLI wrote to disk, so it survives the
 * process (cursor). The distinction is not decoration: it is what separates
 * "there was nobody to ask" from "we asked and got nothing", which are the two
 * sentences the readout has to choose between.
 */
export type UsageReadChannel = 'live-process' | 'session-store';

/**
 * Whether one of the two window/plan questions can be put to this CLI at all,
 * and if so where the answer comes from.
 *
 * The `unavailable` arm's reason is a SENTENCE rendered verbatim where the
 * figures would have been, matching `handoff`'s own shape — and the two facts
 * ride ONE field so a CLI cannot declare a reason beside a channel that
 * contradicts it.
 */
export type UsageReading =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'reads'; readonly channel: UsageReadChannel };

/**
 * One line item of the context window, as the CLI itself accounts for it.
 *
 * The names are the CLI's OWN and are deliberately not normalized into a
 * geniro vocabulary: they are what that CLI's own `/context` prints, so a user
 * comparing the two surfaces sees the same words, and a CLI that invents a new
 * category next month shows it rather than dropping it into "other".
 */
export interface AgentContextCategory {
  name: string;
  tokens: number;
  /**
   * This category is AVAILABLE but not loaded — claude's deferred tool
   * surface, which costs nothing until something searches for a tool in it.
   *
   * Excluded from {@link AgentContextUsage.totalTokens} by the CLI (verified
   * by arithmetic on a live reading: the non-deferred rows sum exactly to the
   * total, and free space is the window minus it). A consumer that renders
   * these in the same bar as the rest reports a window several times fuller
   * than it is — measured, 273,876 deferred MCP tokens against a 98,598 total.
   */
  deferred: boolean;
}

/** One file the agent loaded as standing instructions, and what it costs. */
export interface AgentContextMemoryFile {
  path: string;
  /** The CLI's own word for where it came from (`Project`, `AutoMem`, …). */
  kind: string | null;
  tokens: number;
}

/**
 * One MCP server's whole tool surface, summed.
 *
 * Per SERVER and never per tool, which is the difference between a readout and
 * a data dump: a live reading here carried 371 tools across 46 servers, and
 * the actionable fact in it — one server accounting for 109k of the 274k — is
 * visible only once they are summed. The per-tool rows are dropped at the
 * adapter rather than sent and hidden, because the wire cost is the point (the
 * raw reply is ~80KB, most of it tool descriptions the user cannot act on).
 */
export interface AgentContextServer {
  name: string;
  tokens: number;
  toolCount: number;
  /** How many of those tools are actually loaded into the window right now. */
  loadedToolCount: number;
}

/**
 * What one agent's context window holds at the moment it was asked.
 *
 * A SNAPSHOT and not an accumulation: it is read from a live process, so it
 * describes that conversation as it stands, including work done inside a turn
 * that has not finished. Every field is nullable because a CLI reports what it
 * reports — a reading missing `maxTokens` still has categories worth showing,
 * and inventing a denominator is the defect `ContextMeter` already documents.
 */
export interface AgentContextUsage {
  /** In the CLI's own order, which is the order its own readout uses. */
  categories: AgentContextCategory[];
  /** What the non-deferred categories sum to, as the CLI itself totals them. */
  totalTokens: number | null;
  /** The window {@link totalTokens} is measured against. */
  maxTokens: number | null;
  /** Which model that window belongs to, when the CLI named one. */
  model: string | null;
  /**
   * The token count at which this CLI would compact the conversation by
   * itself, and whether it is switched on — null when the CLI says nothing.
   *
   * Worth surfacing because it is the number that actually bounds a
   * conversation: `maxTokens` is where the model stops, but this is where the
   * agent's own history gets rewritten, and it is what a user watching a long
   * session is really counting down to.
   */
  autoCompactAtTokens: number | null;
  autoCompactEnabled: boolean | null;
  memoryFiles: AgentContextMemoryFile[];
  servers: AgentContextServer[];
}

/**
 * What a caller can offer an adapter that is being asked something about a
 * run's agent — its context window, the plan limits behind its account.
 *
 * BOTH channels, because the two shipped CLIs answer from different places and
 * neither shape covers the other: claude answers from its RUNNING process, and
 * cursor answers from the session store it wrote to DISK — which is readable
 * with no process at all, and is its only route, since a cursor process does
 * not outlive its turn. An input carrying only a live session would make the
 * second unimplementable; one carrying only an id would make the first.
 *
 * Named for the CHANNELS rather than for one question, because it now serves
 * two and neither owns it.
 */
export interface AgentSessionReadInput {
  /**
   * The run's live CLI process, or null when it holds none — idle, reaped, or
   * a CLI that never keeps one.
   */
  live: AgentSession | null;
  /** That conversation's CLI session id, or null before the CLI names one. */
  sessionId: string | null;
}

/**
 * One rate-limit window an account's plan enforces — the thing that actually
 * stops a conversation, and the thing the app could not previously say anything
 * about.
 *
 * A LIST of windows rather than one figure, because a plan enforces several at
 * once and the binding one changes through the week: a five-hour session window
 * refills over lunch while a seven-day one does not, so a readout showing only
 * the first tells a user they have room on the day they are about to be cut off.
 * Which windows exist is the CLI's business, never this app's.
 */
export interface AgentPlanWindow {
  /**
   * The CLI's own key for this window, opaque here — carried so a reader can
   * tell two rows apart without parsing the label a human sees.
   */
  key: string;
  /** What to call it on screen, in the CLI's own vocabulary. */
  label: string;
  /** How much of it is used, 0-100. */
  percent: number;
  /** When it refills (ISO 8601), or null when the CLI named no moment. */
  resetsAt: string | null;
}

/**
 * What the account behind one chat is allowed, as its CLI reports it.
 *
 * Per CHAT and not per app, which is the whole reason it rides the chat metrics
 * route: a run carries its own `configDir`, so two threads open side by side can
 * be signed in to different accounts on different plans, and one figure in a
 * global header would be describing whichever of them the app happened to ask.
 *
 * Null from an adapter means "no reading", never "no limits" — an unlimited
 * account and a CLI that cannot be asked must not render the same.
 */
export interface AgentPlanLimits {
  /** The subscription in the CLI's own word ('pro', 'max', …), or null. */
  plan: string | null;
  /** In the CLI's own order, which is the order its own readout uses. */
  windows: AgentPlanWindow[];
}

/**
 * Where one task on an agent's own list stands.
 *
 * The three every shipped CLI uses, measured on both: claude's `TaskUpdate`
 * takes `pending`/`in_progress`/`completed`, and cursor's `cursor/update_todos`
 * rows carry the same three words. A status outside them reads as null rather
 * than being coerced into one of these — a wrong reading of "where is this
 * task" is worse than an honest "the CLI said something we do not know".
 */
export type AgentTaskStatus = 'pending' | 'in_progress' | 'completed';

/** One task on the agent's own list, as {@link AgentEvent} `task_list` carries it. */
export interface AgentTask {
  /**
   * The CLI's own id for the task — the join key across announcements, which is
   * what makes a patch applicable at all. Both shipped CLIs number them (`"1"`,
   * `"2"`, …); the value is opaque here and never parsed.
   */
  id: string;
  /**
   * What the task IS. Null in a patch that only moves a status and repeats no
   * text (claude's `TaskUpdate` sends `{taskId, status}` and nothing else), in
   * which case the consumer keeps the title it already had for that id.
   */
  title: string | null;
  /** Null when the CLI named a status this daemon does not recognise. */
  status: AgentTaskStatus | null;
  /**
   * The present-continuous label a CLI shows while the task runs ("Reading the
   * file"). Null for a CLI that has none, and null for claude's `TaskCreate`
   * even though the tool takes one — see `claude-tasks.utils.ts` for why the
   * two halves cannot be paired without state the mapper deliberately lacks.
   */
  activeForm: string | null;
}

/**
 * Normalized streaming event emitted by an agent adapter during one turn. This
 * is the shared model both the Claude and Cursor adapters converge their
 * divergent NDJSON onto (the spec's TextChunk/ReasoningChunk/ToolCallRequest/
 * ToolCallComplete/TurnComplete/TurnCancelled/Error), plus a `session` event
 * carrying the CLI session id for resume.
 */
export type AgentEvent = AgentEventOrigin & AgentEventBody;

/**
 * What the USER can do about a failed turn, when the failure has a known cure.
 *
 * Stamped by the adapter layer, because recognising the failure is a fact about
 * one CLI's wording; acted on by the renderer, which only ever reads the verdict
 * and so never learns a CLI's name. `cli-login` is the only member today: an
 * expired account session, cured by signing the CLI back in.
 *
 * Absent means "no known recovery" — the row renders as an ordinary error. That
 * is the honest default: a wrong action offered on an unrelated failure sends
 * the user to a command that cannot fix what they hit.
 */
export type AgentErrorRecovery = 'cli-login';

/**
 * What was known about a failure BESIDES the sentence it was reported with.
 *
 * A failed turn used to reach the transcript as one line of prose and nothing
 * else — "API Error: Connection lost mid-response. The response above may be
 * incomplete." — which says what happened and nothing anyone could act on or
 * hand to whoever runs the model. Every field here is something the CLI already
 * put on the wire and geniro was dropping, measured on claude 2.1.234 by
 * forcing a failure (`--model definitely-not-a-model`):
 *
 *   {"type":"assistant", … ,"error":"model_not_found",
 *    "request_id":"req_011CeAL4KP2RkG9YEPGrdi2n","is_api_error_message":true}
 *   {"type":"result","is_error":true,"terminal_reason":"api_error",
 *    "api_error_status":404,"session_id":"…","duration_ms":986,
 *    "subtype":"success", …}
 *
 * Note `subtype` on that line: it says `success` on a failure, which is why it
 * is not the code and why appending it to the message was actively misleading.
 *
 * EVERY field is optional and none is invented: a CLI that reports none of this
 * produces an error row byte-identical to the one it produced before. The
 * renderer reads them back through a twin parser (`chats/error-payload.ts`).
 */
export interface AgentErrorDetail {
  /**
   * The CLI's own machine-readable name for what failed — `model_not_found`,
   * `api_error`. Searchable in the vendor's vocabulary in a way prose is not.
   */
  code?: string;
  /** The HTTP status the model's endpoint answered with. */
  httpStatus?: number;
  /**
   * The provider's own id for the failed request.
   *
   * The single most useful field here and the one nothing else can substitute:
   * it is what a provider can look up, and it exists nowhere in the app unless
   * it is carried across from the line that reported it.
   */
  requestId?: string;
  /** The CLI session the failure happened in. */
  sessionId?: string;
  /** How long the turn had been running when it failed. */
  durationMs?: number;
  /** The process's exit code, when it died rather than reported. */
  exitCode?: number;
  /** The signal that killed the process, when one did. */
  signal?: string;
}

/**
 * WHICH thread of one turn produced an event.
 *
 * A CLI that runs sub-agents emits their output on the SAME stream as the main
 * thread's, so without this every consumer reads one interleaved sequence and
 * cannot tell the two apart. That is not a cosmetic gap: a sub-agent's own
 * assistant line carries its own small, fresh context usage, so attributing it
 * to the turn made the context meter jump backwards and snap forward again,
 * and its tool calls landed in the transcript as top-level rows beside the main
 * thread's.
 *
 * ABSENT means the main thread — the overwhelmingly common case, and the
 * reading for any CLI that does not report this at all (no ACP agent sets it).
 * Deliberately not `string | null`: one state deserves one representation, and
 * a nullable form invites an adapter to write `=== null` at a read site that
 * would then miss every main-thread event. A present value is the id of the
 * tool call that started the sub-agent, so it doubles as the key joining a
 * sub-agent's rows to the parent row they belong under.
 */
interface AgentEventOrigin {
  parentToolUseId?: string;
}

type AgentEventBody =
  | { type: 'text'; text: string }
  | {
      /**
       * A message the USER wrote, as the CLI reports it back.
       *
       * Produced ONLY while replaying a conversation geniro does not already
       * hold — the import of an existing CLI session. In an ordinary turn the
       * daemon wrote the prompt itself and persisted it before the CLI ever saw
       * it, so a CLI echoing it back is a duplicate and every adapter drops it
       * (ACP's `user_message_chunk`, which is exactly this line arriving during
       * a normal `session/load`).
       *
       * It exists because a transcript with the user's half missing is not the
       * conversation: an imported thread would open on a column of answers to
       * questions nobody can see. That could not be expressed with `text`,
       * whose row is `role: 'assistant'` by definition.
       */
      type: 'user_message';
      text: string;
    }
  | {
      /**
       * An INCREMENT of assistant text, as the CLI generates it — the live
       * plane behind a growing bubble.
       *
       * EPHEMERAL BY CONTRACT: a delta is never persisted, never allocated a
       * `seq`, and never replayed. The completed `text` event that follows is
       * the durable record of the same words, so a client that missed deltas
       * (a reconnect mid-block) loses nothing. `mapEventToItem` returns null
       * for it, and that switch is deliberately default-less so a new arm
       * cannot silently become a database row.
       */
      type: 'text_delta';
      text: string;
    }
  | {
      /**
       * An INCREMENT of the model's REASONING text — the live plane behind a
       * thinking stretch, for a CLI that discloses what it is thinking.
       *
       * The twin of `text_delta`, and separate from it for the reason the
       * durable `reasoning` event is separate from `text`: these words are the
       * agent working something out, not the answer, and merging them would
       * put its scratch notes in the assistant's own bubble.
       *
       * It exists because {@link AgentEvent} `thinking_progress` cannot carry
       * them. That event answers the same question for a CLI whose thinking is
       * REDACTED (headless claude), where a running token total is all there
       * is — so a CLI that does disclose the text had no channel at all, and
       * its reasoning reached the transcript only when the block closed. On
       * cursor that is measured at up to several minutes of a screen showing
       * nothing but `Working…` while thought chunks were arriving the whole
       * time.
       *
       * EPHEMERAL, exactly like `text_delta`: never persisted, never allocated
       * a `seq`, never replayed. The `reasoning` event that follows is the
       * durable record of the same words.
       */
      type: 'reasoning_delta';
      text: string;
    }
  | {
      /**
       * The model is REASONING, with the tokens it has spent so far.
       *
       * For a CLI that REDACTS its thinking: headless claude ships the block
       * with an encrypted `signature` and an empty body (probe-verified —
       * `--include-partial-messages` does not reveal it), so a running total is
       * the only honest signal that the agent is working during an otherwise
       * silent stretch. A CLI that discloses the words sends `reasoning_delta`
       * instead. EPHEMERAL, exactly like {@link AgentEvent} `text_delta`: never
       * persisted, never replayed.
       */
      type: 'thinking_progress';
      tokens: number;
    }
  | {
      /**
       * How full the model's context window is as of the request that just
       * produced output — the live counterpart of the `turn_complete` usage.
       *
       * Every claude `assistant` line carries its own request's prompt-side
       * usage (probe-verified on 2.1.220), so the meter can move DURING a turn
       * instead of jumping once at the end, which is what made it read stale.
       * EPHEMERAL, exactly like {@link AgentEvent} `text_delta`: never
       * persisted, never replayed.
       */
      type: 'context_progress';
      contextTokens: number;
      /**
       * The window those tokens are measured against, and which model it
       * belongs to — when THIS reading knows them.
       *
       * Absent for a CLI whose two halves arrive on different lines: claude
       * reports the used side on every `assistant` line and the window only on
       * `result`, which is why the window used to ride nowhere but
       * `turn_complete`. Present for one answering off its OWN accounting,
       * where used and window are a single reading — and splitting them there
       * would leave the meter a numerator with no denominator, which is
       * precisely what a cursor chat showed: a full breakdown in the panel
       * behind a ring that had never been given a window to be a fraction of.
       */
      contextWindowTokens?: number | null;
      contextModel?: string | null;
    }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      input: unknown;
      /**
       * WHAT KIND of work this call is, in one vocabulary shared by every agent:
       * ACP's own `ToolKind` (`read` | `edit` | `delete` | `move` | `search` |
       * `execute` | `think` | `fetch` | `switch_mode` | `other`). Absent when the
       * CLI does not classify its calls.
       *
       * It exists because the alternative is a reader recognising one CLI's tool
       * NAMES, which is what the transcript did: the group summary bucketed on
       * `Read`/`Edit`/`Bash` and on an `input.file_path`, so a cursor turn — whose
       * calls are titled "Read File", "Edit File", "grep" and disclose no
       * arguments at all — fell through to "Used 2 tools" and named nothing it had
       * done. The vocabulary is ACP's rather than geniro's own because one agent
       * already speaks it on the wire, so only the other side needs a mapping.
       */
      kind?: string;
    }
  | {
      type: 'tool_result';
      id: string;
      name: string | null;
      result: unknown;
      isError: boolean;
    }
  | {
      type: 'turn_complete';
      usage: AgentUsage | null;
      stopReason: string | null;
      /**
       * The agent's final answer text as the CLI's result line reports it —
       * what a downstream graph node receives as its input context. Null when
       * the CLI's result carries no text (callers fall back to concatenating
       * the turn's `text` events).
       */
      finalText: string | null;
    }
  | { type: 'turn_cancelled' }
  | {
      type: 'error';
      message: string;
      recovery?: AgentErrorRecovery;
      /** See {@link AgentErrorDetail} — absent when the CLI reported nothing. */
      detail?: AgentErrorDetail;
    }
  | { type: 'session'; sessionId: string }
  | {
      /**
       * A notice about THIS turn, persisted as a `system` transcript item so it
       * is visible to the user rather than silent. NOT terminal: the turn
       * continues after one.
       *
       * Two kinds of text arrive here, and {@link origin} is what tells them
       * apart. The default is an ADAPTER-level advisory the daemon itself wrote
       * — a capability the CLI did not grant, a request that degraded — which
       * the renderer is right to surface like an error. The other is text the
       * CLI produced, which is not an advisory at all and must not be dressed as
       * one.
       */
      type: 'notice';
      message: string;
      /**
       * Who wrote {@link message}. Absent means the daemon did, which is the
       * historical case and the one every existing producer means.
       *
       * `cli` marks text the AGENT produced and geniro is only relaying —
       * claude's own compaction summary is the first. It matters for two
       * reasons. Presentationally, that text is informational prose, and
       * rendering it in the daemon's failure chrome told the user geniro was
       * reporting a problem when it was relaying a summary. And as a trust
       * boundary: the summary describes a conversation that can contain file
       * contents, command output and web pages, so it is UNTRUSTED content
       * which must not be able to impersonate an application-level advisory.
       */
      origin?: 'cli';
      /**
       * How loud the daemon's own notice should be. Absent means the failure
       * chrome, which is the historical case for every producer that names no
       * severity.
       *
       * `info` exists for the daemon notices that are not advisories about
       * something going wrong — the one that says a request the CLI raised
       * between turns was KEPT for the user rather than answered on their
       * behalf. That is the machinery working, and rendering it in the failure
       * chrome got it reported as an error the user "still sees sometimes":
       * red, capitalised SYSTEM, two lines of explanation, directly above the
       * card it is pointing at. Nothing was wrong, so nothing should look it.
       *
       * `warning` is the middle the same report asked for from the other side:
       * a setting the user CHOSE did not apply, so it cannot be quiet — but the
       * turn ran, so red is a lie about what happened ("a strange error … and
       * then it carried on working"). It is the level for a DEGRADE the user
       * can act on: a model that has no `max` effort, a mode the agent does not
       * offer. Keeping it distinct from the absent case is the point — a
       * producer that has not thought about volume still gets the loud one.
       *
       * Meaningless beside `origin: 'cli'` and ignored there — relayed agent
       * text is never an advisory at any volume, and letting it choose its own
       * severity is exactly the impersonation `origin` exists to prevent.
       */
      severity?: 'info' | 'warning';
      /**
       * What KIND of notice this is, in two or three words — the row's caption,
       * where the reader learns what they are looking at before reading the
       * sentence.
       *
       * Absent takes the renderer's default for the severity, which is what
       * every historical producer means. It exists because that default is a
       * SENTENCE about one case: a `warning` is captioned `not applied`, which
       * is true of the degrades the level was added for (an effort the model
       * does not offer) and false of the other thing that is loud-but-not-fatal
       * — a request that FAILED and was retried. One default phrase for a whole
       * severity is how the second producer comes to file its row under the
       * first's explanation.
       *
       * Meaningless beside `origin: 'cli'` and dropped there, by the same rule
       * as {@link severity}: relayed agent text is not an advisory, so it does
       * not get to caption itself as one.
       */
      caption?: string;
    }
  | {
      /**
       * WHAT a background sub-agent of this turn IS, announced by the CLI apart
       * from the tool call that launched it.
       *
       * For a CLI whose delegates stream their own work (claude), the launching
       * tool call's arguments already carry the description, the prompt and the
       * type, and no adapter needs this. It exists for the other shape, measured
       * on `cursor-agent acp`: the `task` tool call opens with `rawInput` holding
       * nothing but the tool's own name, and the delegate's brief arrives later
       * on a separate channel (`cursor/task`) — so without a row of its own,
       * everything the CLI says about its delegate is discarded.
       *
       * {@link id} is the LAUNCHING TOOL CALL's id, which is what joins this
       * announcement to the row that started the delegate. Deliberately in the
       * body rather than as {@link AgentEventOrigin.parentToolUseId}: that field
       * means "the delegate PRODUCED this row", and this row is one ABOUT the
       * delegate, written by the main thread. Conflating them would fold the
       * announcement into the delegate's own thread as an invisible entry, which
       * is precisely what makes "did this delegate do anything?" unanswerable.
       *
       * Emitted more than once per delegate BY DESIGN — once when the launch is
       * recognised (anchor only, so the block can open while the delegate is
       * still working) and again when the facts arrive. Every field is nullable
       * for that reason, and the consumer merges by preferring the last non-null
       * value it saw.
       */
      type: 'subagent_info';
      /** The launching tool call's id. */
      id: string;
      /** One-line description of the delegated task, as the CLI named it. */
      label: string | null;
      /** What the delegate was asked to BE — the CLI's own type/role name. */
      kind: string | null;
      /** The full brief the delegate was given. */
      prompt: string | null;
      /** The model it ran, when the CLI names one. */
      model: string | null;
      /** How long it took, when the CLI reports it. */
      durationMs: number | null;
      /**
       * How many tokens the delegate spent, and how many tools it called, when
       * the CLI reports them — {@link BackgroundUnitUsage}.
       *
       * There is deliberately no COST field beside them. Probed on claude
       * 2.1.237 across every channel that says anything about a delegate: the
       * `task_notification` reports `{total_tokens, tool_uses, duration_ms}`,
       * the launching call's `tool_use_result` adds `resolvedModel` and a token
       * breakdown, the delegate's own sidechain JSONL holds no money figure at
       * all, and the turn's `result` line prices the whole turn — its
       * `modelUsage[model].costUSD` covers the main thread and every delegate
       * together, with no way to split it. Deriving one would mean carrying a
       * price table this app has no source for, so the delegate is reported in
       * the units its CLI actually measured.
       */
      tokens: number | null;
      toolUses: number | null;
      /**
       * {@link AdapterConfig.subagents.stepsUnavailableReason} — why this
       * delegate's own conversation is absent. Null for a CLI that streams it.
       */
      stepsUnavailableReason: string | null;
      /**
       * HOW this delegate ended, when the CLI said — {@link
       * BackgroundUnitOutcome}, `null` while it is still out or when the CLI
       * reports only THAT the work is over.
       *
       * A settle on its own says only that the work is no longer open, which
       * is not the same as success — so absent must read as "nothing was
       * said", never as `completed`.
       */
      backgroundOutcome: BackgroundUnitOutcome | null;
      /**
       * Whether this delegate is still working in the BACKGROUND — `true` while
       * it is out, `false` once the CLI reports it done, `null` when nothing has
       * been said either way.
       *
       * The three states are load-bearing, because the usual end-of-delegate
       * signal is the launching tool call RETURNING, and a fire-and-forget
       * delegate returns at once: measured on claude 2.1.232, a turn told not to
       * wait got its `Task` result back in under a second while the delegate ran
       * on for a further 50, so the transcript closed its block and the app
       * reported no delegates working while three were. `null` therefore has to
       * mean "no claim" rather than "not running" — every other producer emits
       * nothing here and keeps the old reading, where the tool result is the end.
       */
      backgroundOpen: boolean | null;
    }
  | {
      /**
       * A background SHELL the CLI started or finished — the delegate
       * announcement's twin, for the units on that same channel that are not
       * delegates.
       *
       * It exists because a detached command's launching tool call returns
       * INSTANTLY (`Command running in background with ID: …`) and the command
       * then runs for minutes. That leaves the transcript with no end signal at
       * all: measured on claude 2.1.237, a 45-second `sleep` reported its
       * completion to the MODEL as a `system/task_notification` frame and to
       * the conversation as an ordinary sentence the agent wrote — so a client
       * folding "what is running" out of tool calls alone lists it forever, and
       * the count climbs all session. The frames were already parsed here (see
       * `background_work`) and thrown away for want of anywhere to put them.
       *
       * A ROW rather than a live signal, on the same rule as `task_list`: a
       * reopened chat replays the transcript, so an ephemeral end would leave
       * every past background command listed as running again.
       *
       * Announced only on the SETTLE. The start is already in the transcript as
       * the tool call itself, and a second row saying so would double every
       * background command for nothing.
       */
      type: 'shell_info';
      /**
       * The tool call that launched it, when the CLI ties one to the unit —
       * which is what joins this to the shell already in the transcript.
       *
       * Null when only the CLI's own work id is known: a settle names the call
       * on one of the two channels and not the other, and a session that
       * resumed after the launch never saw the `started` that would have paired
       * them. The consumer then matches on {@link workId} instead, which is why
       * both ride every announcement.
       */
      toolCallId: string | null;
      /** The CLI's own id for the unit (claude's `task_id`, e.g. `bash_1`). */
      workId: string;
    }
  | {
      /**
       * The agent's OWN task list moved — the todo list a coding CLI keeps for
       * itself while it works through a multi-step job.
       *
       * Every shipped CLI has one and each reports it differently, so this is
       * the normalized form all of them collapse to. What made it worth a
       * dedicated event rather than leaving it as the tool call it rides on:
       * the tool call says only that a tool NAMED something was invoked, and
       * cursor's carries no arguments at all (`rawInput:{_toolName:
       * "updateTodos"}`), so the list itself never reached the transcript.
       *
       * {@link mode} is the whole subtlety. Two of the three shapes measured
       * are PATCHES — they name only the rows that moved — so a consumer that
       * treats every announcement as the complete list shows one task where
       * there are seven. It is not inferred from the contents (a patch that
       * happens to name every row is indistinguishable from a snapshot); the
       * CLI says which it sent, and cursor says so literally (`merge`).
       */
      type: 'task_list';
      /**
       * `snapshot` — {@link tasks} IS the list now, and anything absent from it
       * is gone. `patch` — only the named rows moved; every other task stands
       * as it was.
       */
      mode: 'snapshot' | 'patch';
      tasks: AgentTask[];
      /**
       * The tool call this announcement belongs to, when the CLI ties one to
       * it — so the consumer can render the list INSTEAD of the opaque tool row
       * that produced it rather than beside it. Null when the CLI reports the
       * list without one.
       */
      toolCallId: string | null;
    }
  | {
      /**
       * A unit of BACKGROUND work this turn started, which the turn must
       * outlive — opened by `started`, closed by `settled`.
       *
       * Turn plumbing, not conversation: `runCliSession` consumes it and never
       * forwards it, so it is not an item and no consumer sees it.
       *
       * It exists because a CLI's turn-end line is not the end of its WORK.
       * Measured on claude 2.1.231: a `result` line arrives while a delegate the
       * turn launched is still running, and the CLI then runs FURTHER turns of
       * its own accord as each reports back (that continuation's own `result`
       * carries `origin: {kind:'task-notification'}`). Settling on the first
       * `result` therefore ends geniro's turn in the middle of the work — and
       * everything after it becomes a between-turn orphan: measured across the
       * author's own daemon log, 11 of 31 settles were followed by off-turn
       * work, up to 33 minutes and 997 events past the settle, including 227
       * whole assistant messages dropped and 430 permission requests answered
       * with no card ever shown. The run reported `completed` throughout.
       *
       * {@link id} is the CLI's own handle for that work, and only identity
       * matters: the set is keyed by it so a `settled` for something never
       * opened is a no-op and a duplicate `settled` cannot close a second one.
       * A CLI reporting the same unit on two channels (claude reports each of
       * its tasks on both `task_updated` and `task_notification`) is therefore
       * safe to map from both, which is what keeps a version that drops one of
       * them working.
       *
       * A CLI that reports no such lifecycle simply never emits this, and its
       * turns settle exactly as before — this is not a capability an adapter
       * has to declare, because the absence is indistinguishable from having no
       * background work.
       */
      type: 'background_work';
      /** The CLI's own id for this unit of work. */
      id: string;
      phase: 'started' | 'settled';
      /**
       * HOW it ended, on a `settled` — {@link BackgroundUnitOutcome}.
       *
       * Absent on a `started`, and absent on a settle from a CLI that reports
       * only that the work is over. The three states matter for the same reason
       * {@link AgentEvent} `subagent_info`'s `backgroundOpen` has three: absent
       * must read as "nothing was said", never as success, or a CLI with no
       * outcome vocabulary would have every delegate reported as having
       * completed.
       */
      outcome?: BackgroundUnitOutcome;
      /**
       * WHAT this unit is, when the CLI says — a delegate (`agent`) or anything
       * else it runs in the background (a shell command, an indexing pass).
       *
       * It exists because the two need different treatment downstream and only
       * the adapter can tell them apart: measured on claude 2.1.232, one turn's
       * `task_started` lines carried `task_type: 'local_agent'` for the delegate
       * AND `task_type: 'local_bash'` for the `sleep` that delegate then ran, on
       * the same channel. Counting the second as a sub-agent would report two
       * delegates where the user launched one.
       *
       * `'other'` is the safe default for a CLI that says nothing, and what it
       * is safe ABOUT is the transcript: no phantom sub-agent is announced for
       * it. It no longer keeps the turn open either — only an `agent` unit does
       * (see `runCliSession`'s `trackBackgroundWork`) — so a CLI that starts
       * naming its delegates gains the hold along with the block, and one that
       * names nothing gets neither.
       */
      unit: 'agent' | 'other';
      /**
       * The tool call that launched it, when the CLI ties one to it — which is
       * what joins this unit to the sub-agent block already in the transcript,
       * since that block is keyed by exactly that id.
       *
       * Null on a settle whose channel omits it; the correlation is then done by
       * {@link id}, which is why `runCliSession` remembers the pair from the
       * `started` rather than expecting both ends to carry it.
       */
      toolCallId: string | null;
      /**
       * What this unit CONSUMED, when the CLI states it as the unit settles.
       *
       * Only ever on a `settled` phase — nothing is consumed before the work
       * runs — and only from a CLI whose settle channel carries it. Undefined
       * everywhere else, which reads the same as every field being null.
       *
       * It rides the lifecycle event rather than being read straight into a
       * `subagent_info` by the adapter for one reason: this channel carries
       * shell commands and a delegate's own sub-work alongside the delegates,
       * and only `runCliSession` knows which is which — it recorded the unit
       * kind from the `started`, and the settle line does not restate it. An
       * adapter announcing the figures itself would put a phantom sub-agent in
       * the transcript for every backgrounded `sleep`.
       */
      usage?: BackgroundUnitUsage;
    }
  | {
      /**
       * The turn is being HELD open: the CLI has finished talking, and geniro
       * is keeping the turn alive only until the background work it started
       * reports back.
       *
       * NOT produced by any adapter — `runCliSession` raises it, because it is
       * the only thing that knows the difference between "the agent is working"
       * and "the agent has stopped and we are waiting on its listeners". That
       * distinction is invisible from outside: `background_work` alone does not
       * imply the main thread has gone quiet (a delegate runs happily while its
       * parent keeps editing files), and the CLI's own turn-end line is
       * swallowed by the hold, so nothing downstream can see it arrive.
       *
       * It exists for two consumers that were both getting the state wrong.
       * The badge said "running Read" about a turn whose read had returned
       * minutes earlier; and the composer refused to send, holding the message
       * in the queue on the grounds that "the agent is working" — reported as
       * "if claude is running agents in background it's like it stopped to work
       * until it gets a notification from them… we should not send the message
       * to the queue while it's just waiting for listeners".
       */
      type: 'turn_held';
      /** How many units of background work are still outstanding. */
      open: number;
    }
  | {
      /**
       * The CLI reported the session's invokable slash commands (claude's
       * `system/init` `slash_commands`: built-ins + plugin skills + user and
       * project skills/commands, shadowing already resolved — verified live
       * on 2.1.211; cursor's ACP `available_commands_update`, which carries a
       * description per entry). Captured into the skill-harvest store keyed by
       * the turn's cwd — never a transcript item.
       */
      type: 'slash_commands';
      commands: AgentReportedCommand[];
    }
  | {
      /**
       * The MCP servers the CLI had loaded for this turn, with the connection
       * status each was in when the turn began (claude's `system/init`
       * `mcp_servers` — verified live on 2.1.222). Captured into the
       * MCP-harvest store keyed by the turn's cwd and config directory — never
       * a transcript item.
       *
       * Reported because the ALTERNATIVE is a cold re-dial: asking a CLI for
       * its servers out of band starts every one of them to health-check it,
       * which is what made the panel take seconds. A turn already knows.
       *
       * A CLI with no such report simply never emits this — there is nothing
       * for an adapter to declare, because the harvest is an optimisation over
       * `listMcpServers`, never the only source.
       */
      type: 'mcp_servers';
      servers: AgentMcpServer[];
    }
  | {
      /**
       * The model this turn is actually running as, named by the CLI at
       * session start (claude's `system/init` `model` — verified live on
       * 2.1.220, where it reads `claude-opus-5[1m]`).
       *
       * Reported because the WINDOW is not: no line before the turn's `result`
       * carries one, so a run's first turn had nothing to scale its live
       * context figure against and fell back to an assumed 200k — which is
       * how a 1M-window model came to be shown measuring against a fifth of
       * its context. Naming the model is enough: the window learned when a
       * turn of that same model finished can be applied from the start.
       *
       * EPHEMERAL — never a transcript row. The durable record of what a turn
       * ran as is the run row itself.
       */
      type: 'turn_model';
      model: string;
    }
  | {
      /**
       * The CLI is compacting the conversation, or has finished doing so — it
       * summarises the history and carries on with a much smaller context.
       *
       * REPORTS BOTH ENDS, which it did not always. This arm used to say "the
       * past, never the present", on 2.1.226 evidence that only the
       * post-compaction boundary is serialised. On 2.1.227 that is no longer
       * true: the CLI emits `{"type":"system","subtype":"status",
       * "status":"compacting"}` when the work STARTS (see
       * `CLAUDE_COMPACTING_STATUS`). A compaction measured 46s in that probe,
       * so the interval this now names is exactly the one a user spent watching
       * an unexplained "Working…".
       *
       * Worth reporting at both ends because the alternative is a mystery: a
       * long unexplained pause, and then the context meter dropping by most of
       * the window between one request and the next.
       *
       * EPHEMERAL — never a transcript row, at either phase. A `system` item
       * saying "compacted" is housekeeping the user did not ask for in the
       * middle of the conversation they did. What DOES earn a row is the CLI's
       * own summary text and a compaction that FAILED, and both arrive as their
       * own lines rather than on this arm.
       */
      type: 'context_compacted';
      /**
       * Which end of the compaction this is, and how it ended.
       *
       * `started` and `failed` carry no token counts — nothing was dropped in
       * either case — so a consumer that renders numbers must read this first.
       * Required rather than optional: a consumer that ignored it would announce
       * a finished compaction the moment one began.
       *
       * `failed` exists because `started` puts up a PRESENT-TENSE state that
       * something has to take down. Only the success path emits a boundary, so
       * without a failure arm the phrase "compacting the conversation" outlived
       * a compaction the CLI had already declined — and a refusal is the common
       * case, since a short conversation answers `/compact` with "Not enough
       * messages to compact.".
       */
      phase: 'started' | 'finished' | 'failed';
      /** `auto` (the window filled) or `manual` (`/compact`); null if unstated. */
      trigger: string | null;
      /** Context size before the compaction, when the CLI reports it. */
      preTokens: number | null;
      /** Context size after it, when the CLI reports it. */
      postTokens: number | null;
    }
  | {
      /**
       * The CLI sent a control message on the stdin dialogue that this adapter
       * does not model, carrying the subtype it was.
       *
       * DIAGNOSTIC ONLY — never a transcript item, never delivered to a turn's
       * consumer: {@link AgentAdapter.start} logs it and drops it. It exists
       * because the mappers are pure module-scope functions that cannot log,
       * so an unmodelled subtype has to travel back to the caller AS DATA to
       * be visible at all. Before it, a control subtype we did not recognize
       * vanished into a bare `return []`.
       */
      type: 'unhandled_control';
      subtype: string;
    }
  | {
      /**
       * The CLI paused mid-turn asking permission for a tool call (`ask`
       * approval mode). The turn stays blocked until the verdict goes back via
       * `AgentTurnHandle.respondApproval(id, …)`.
       */
      type: 'approval_request';
      id: string;
      toolName: string;
      input: unknown;
      /**
       * The CLI flagged this request as a genuine USER QUESTION (claude sets
       * `requires_user_interaction` on AskUserQuestion), not a permission
       * check. The graph executor routes flagged requests from call-initiated
       * turns to the caller (the M4 Q&A bridge) instead of auto-approving.
       */
      requiresUserInteraction?: boolean;
    };

/**
 * One image attached to a turn, as the adapters receive it: a path on disk
 * plus the media type the CLI must be told. Adapter-agnostic — how it reaches
 * the child (content block vs path in the prompt) is each adapter's business.
 */
export interface TurnImage {
  path: string;
  mediaType: string;
}

/**
 * A message the user sent while a turn was ALREADY running, for delivery into
 * that running turn rather than the next one.
 *
 * The same two fields a turn starts with, and deliberately no more: a follow-up
 * changes what the agent is asked, never how it runs. Model, approval mode,
 * cwd and the call surface all belong to the turn that is already in flight.
 */
export interface FollowUpMessage {
  text: string;
  images?: TurnImage[];
}

/**
 * One model a CLI will accept for `--model`, as that CLI reports it.
 *
 * `id` is passed through verbatim — never normalized, since only the CLI knows
 * which spellings it honours. `label` is what the picker shows.
 */
export interface AgentModel {
  id: string;
  label: string;
  /** How this entry was obtained — the UI says so when it is not live. */
  source: 'cli' | 'builtin';
}

/**
 * One reasoning-effort level a CLI accepts for a turn, as that CLI names it.
 *
 * `id` is passed through verbatim — the flag's vocabulary belongs to the CLI,
 * and only its adapter knows which spellings it honours. `label` is what the
 * picker shows.
 */
export interface AgentEffort {
  id: string;
  label: string;
}

/**
 * The effort levels available for ONE model, and the reason when there are none.
 *
 * Per model rather than per CLI, because that is what the CLIs turned out to
 * be — measured on cursor-agent 2026.08.11-e8db854, `claude-opus-5` takes
 * `max` and `grok-4.6` does not, while `auto-smart` and `composer-2.5` have no
 * effort axis whatever. A CLI-wide list therefore OFFERS values a given model
 * refuses, which is exactly what got reported: a chat on Grok, its effort chip
 * remembering `max` from an Opus run, opening every turn with a declined
 * setting.
 *
 * `unavailableReason` is a SENTENCE and must be non-null whenever `efforts` is
 * empty — the same contract `AdapterConfig.effortsUnavailableReason` carries,
 * for the same reason: a picker that simply disappears is indistinguishable
 * from one that is broken.
 */
export interface AgentEffortListing {
  efforts: AgentEffort[];
  unavailableReason: string | null;
  /**
   * True when this is the NAMED MODEL's own answer; false when it is the
   * CLI-wide superset standing in for one.
   *
   * A picker treats the two alike — rows are rows, and the union is a decent
   * stand-in. A REFUSAL cannot: the union omits levels a given model really
   * offers (`gpt-5.2`'s `extra-high` is absent from cursor's), so refusing on
   * it rejects a level the picker had just shown. The distinction is only
   * visible here, because every fallback in this contract RESOLVES with the
   * superset rather than throwing — a caller watching for a rejection sees a
   * successful listing and cannot tell the two apart.
   */
  exact: boolean;
}

/**
 * One context-window size a model can be run at, as that CLI names it.
 *
 * The same shape as {@link AgentEffort} and for the same reason: `id` is the
 * CLI's own vocabulary, passed through verbatim (`300k`, `1m`, `272k`), and
 * `label` is what the picker shows. Deliberately NOT a token count — geniro
 * does not translate the CLI's word into a number, because the number that
 * matters is the one the agent then reports about its own window, and a table
 * here would be a second answer to that question with nothing keeping it true.
 */
export interface AgentContextWindow {
  id: string;
  label: string;
}

/**
 * The window sizes available for ONE model, and the reason when there are none.
 *
 * Per model, necessarily: probed 2026-08-21 on cursor-agent 2026.08.11-e8db854
 * across all 34 models the account offers, twelve carry the setting and their
 * vocabularies differ — `claude-opus-5` is `300k|1m`, `gpt-5.5` is `272k|1m`,
 * `claude-sonnet-4-6` is `200k|1m` — while the other twenty-two have no such
 * axis at all. So a CLI-wide list would offer sizes a given model refuses,
 * which is the defect `AgentEffortListing` already carries the scars of.
 *
 * `unavailableReason` obeys the same contract as the effort listing's: a
 * SENTENCE whenever the list is empty, because a picker that silently
 * disappears is indistinguishable from a broken one.
 */
/**
 * Which kind of "no sizes to choose from" a listing is reporting.
 *
 * `no-model` is the one that behaves differently downstream: nothing has been
 * asked yet, so a control claiming anything about the model's window would be
 * stating a fact about a model nobody has picked. The other three all mean the
 * turn really does run at exactly one window — this CLI has no such axis, this
 * MODEL offers no choice of its own, or the CLI could not be asked and its own
 * answer is unknown.
 *
 * `fixed-window` was briefly deleted, on the reading that cursor's models
 * without a `context` parameter had a second window after all. They do, and it
 * is not a CHOICE: geniro turns Max Mode on for every cursor turn
 * (`CURSOR_MAX_MODE`), so such a model runs at its largest window with nothing
 * to pick between. The kind is back, and its sentence now names which window
 * that is instead of leaving it unstated.
 *
 * An ENUM rather than the sentence: the reason prose is what a user reads, and
 * a consumer that has to recognise a specific case by matching those words
 * silently changes behaviour the moment the wording is improved.
 */
export type AgentContextWindowUnavailableKind =
  'no-model' | 'no-axis' | 'fixed-window' | 'unreadable';

export interface AgentContextWindowListing {
  windows: AgentContextWindow[];
  unavailableReason: string | null;
  /** Which case {@link unavailableReason} describes; null when sizes are offered. */
  unavailableKind: AgentContextWindowUnavailableKind | null;
  /** True when this is the NAMED MODEL's own answer — see {@link AgentEffortListing.exact}. */
  exact: boolean;
}

/**
 * One setting of a model that geniro has NO dedicated control for, carried
 * exactly as the CLI enumerated it.
 *
 * The two axes above are the ones geniro gave a control of its own, because
 * both mean something in every CLI's vocabulary. They are not the only ones a
 * CLI has. Probed 2026-08-26 on cursor-agent 2026.08.11-e8db854, one seeded
 * handshake per model, reading every `configOptions` entry rather than the two
 * this app knew to look for:
 *
 * - `auto-smart`    → `optimize_for` = intelligence | balanced | cost
 * - `claude-opus-5` → `thinking` = false | true, `fast` = false | true
 * - `gpt-5.6-sol`   → `fast` = false | true
 * - `kimi-k3`, `gemini-3.1-pro` → none beyond what is already surfaced
 *
 * Three axes invisible in the app, and `optimize_for` is the one that was
 * REPORTED ("у курсора есть дефолтный модуль, и мы можем выбрать тип этого
 * дефолтного модуля"). Giving each its own end-to-end stack — service, route,
 * wire type, run column, chip — would have been the third and fourth copies of
 * one mechanism, and the next parameter the CLI adds would need a fifth. So
 * nothing here interprets: an id, a label, its values and whatever the CLI says
 * is current, passed through to a chip that renders whatever it is handed.
 *
 * Which parameters reach this list is the ADAPTER's decision, and it is a
 * subtraction rather than an allowlist — everything the CLI enumerated, minus
 * what geniro already drives through a control of its own. An allowlist would
 * mean a parameter Cursor ships next month stays invisible until someone here
 * notices it, which is the failure this shape exists to end.
 */
export interface AgentModelParameter {
  /** The CLI's own id — what a turn sets, never translated. */
  id: string;
  /** The CLI's own display name; falls back to {@link id} when it names none. */
  label: string;
  /** The values it accepts, in the CLI's own order. */
  values: AgentModelParameterValue[];
  /**
   * The value the CLI reports the model is currently on, when it says.
   *
   * Shown as the chip's own default, so a run that has chosen nothing still
   * reads as what will actually happen. Null when the reply named none.
   */
  current: string | null;
}

/** One accepted value of an {@link AgentModelParameter}. */
export interface AgentModelParameterValue {
  id: string;
  label: string;
}

/**
 * Every {@link AgentModelParameter} of ONE model, and the reason when there are
 * none.
 *
 * `unavailableReason` obeys the contract the two listings above already do — a
 * SENTENCE whenever the list is empty. The difference is what the consumer does
 * with it: there is no chip to hang it on, because with no parameters there is
 * nothing to draw at all, so it exists for the log and for a caller that wants
 * to say why rather than for a control.
 */
export interface AgentModelParameterListing {
  parameters: AgentModelParameter[];
  unavailableReason: string | null;
  /** True when this is the NAMED MODEL's own answer — see {@link AgentEffortListing.exact}. */
  exact: boolean;
}

/**
 * One skill / slash command a CLI can be invoked with (`/name …`).
 *
 * `kind` separates a skill directory from a plain command file; `source` says
 * where it was found — the project folder, the user's home dir, `cli` when the
 * CLI itself reported it rather than the disk scan finding it, or `geniro` for
 * one this application adds (see {@link AgentGeniroCommand}).
 */
export interface AgentSkillEntry {
  name: string;
  description: string | null;
  kind: 'skill' | 'command';
  source: 'geniro' | 'project' | 'user' | 'cli';
}

/**
 * One slash command a CLI reports it can run in a session — the normalized
 * shape behind the `slash_commands` event and the skill harvest.
 *
 * A pair rather than a bare name, because a CLI that has no on-disk convention
 * geniro can scan may still SAY what each command does, and that sentence is
 * the whole value of an autocomplete row: cursor-agent's ACP
 * `available_commands_update` carries `{name, description}` for every entry it
 * reports (27 of them here on 2026.08.11-e8db854), and reading only the name
 * left every cursor row in the composer's `/` popup a bare word — reported as
 * having no hints for that CLI's skills at all.
 *
 * `description` is null for a CLI that names its commands and nothing more —
 * claude's `system/init` `slash_commands` is an array of plain strings — and
 * for that CLI the sentence comes from the disk scan instead, which is why the
 * two sources are merged rather than one chosen.
 */
export interface AgentReportedCommand {
  name: string;
  description: string | null;
}

/**
 * One slash command **geniro itself** provides for a CLI — a command that
 * exists only inside this application, offered beside that CLI's own.
 *
 * It exists because a capability can be real in a CLI's interactive shell and
 * absent from the transport geniro drives. Compaction is the case that forced
 * it: cursor-agent's `/summarize` is a command of its TUI, which sends its own
 * `summarizeAction` over that vendor's private stream — its ACP server
 * advertises only `copy-request-id` plus the commands on disk, and
 * `handleSlashCommand` runs exactly one of them locally. So `/summarize` typed
 * into a geniro chat reached the model as prose and was answered as prose,
 * which is what got reported. The Agent Client Protocol has no compaction
 * method at all (agentclientprotocol discussion #871 is open on exactly this),
 * so there is nothing to wait for on the wire.
 *
 * Declared HERE, per CLI, rather than as a list somewhere central: whether a
 * geniro command is offered at all — and what it costs when it runs — is a fact
 * about that CLI, which is the one rule of `.claude/rules/agent-adapters.md`.
 * The same `/compact` therefore means "the CLI compacts its own history" on
 * claude and "geniro compacts it for you" on cursor, with neither consumer
 * branching on which.
 *
 * The name is RESERVED: `SkillsService` lists these first and the chat service
 * dispatches by name, so a scanned skill of the same name cannot shadow one
 * here — the popup and the behaviour would otherwise disagree.
 */
export interface AgentGeniroCommand {
  /** What the user types after `/`. */
  readonly name: string;
  /** The sentence beside the name in the composer's popup. */
  readonly description: string;
  /**
   * The text this CLI actually receives for the turn — its own slash command
   * verbatim where it has one, geniro's own instruction where it does not.
   *
   * The transcript still records what the USER typed: the rewrite is what the
   * agent is asked, not what the conversation says was asked.
   */
  readonly prompt: string;
  /**
   * Whether the turn's answer REPLACES the CLI's own conversation: its session
   * is dropped once the turn settles and the answer is carried into the next
   * one as context.
   *
   * False for a CLI that compacts its own history and keeps its session, where
   * geniro must change nothing — dropping claude's session after its `/compact`
   * would throw away the very history the CLI had just summarised for itself.
   */
  readonly replacesSession: boolean;
}

/**
 * Health of one MCP server as the CLI itself reports it.
 *
 * `unknown` is for a row that IS recognisably a row but whose health wording
 * this parser does not know — these rows come out of human-readable CLI
 * output, so a reworded release must not throw.
 *
 * An unrecognised status must cost the BADGE, never the row, in every parser:
 * a server the user cannot see is worse than one whose health is unreadable,
 * and a parser that drops what it cannot read can only announce that when
 * EVERY row drops — a partly unfamiliar listing would otherwise return the
 * rows it understood and silently deny the rest. The CALLER still has to turn
 * "nothing parsed, and no empty-folder sentence" into a stated failure; a
 * listing may never degrade into a confident "this folder has none".
 *
 * `pending` is a server that is configured but deliberately not connected to —
 * claude's unapproved `.mcp.json`, cursor's `not loaded (needs approval)`. Read
 * out of cursor's own bundle on 2026.08.11-e8db854, its condition is exact: the
 * server is defined in the PROJECT's `.cursor/mcp.json` and its approval key is
 * not yet in that project's `mcp-approvals.json`, so a user-scope server can
 * never be `pending` there. It is the second status with an ACTION attached —
 * see `AdapterConfig.mcp.approveUnavailableReason` — because approving is a
 * command on one CLI and an interactive screen on the other.
 *
 * `loading` is a server the CLI is still connecting to at the moment it
 * answered. It is a MOMENT, not a state of the configuration: ask again and it
 * becomes `connected` or `failed`. It has its own arm because without one it
 * degraded to `unknown`, which reads as "this row's health is unreadable" — a
 * claim about the parser — where the truth is that the CLI told us plainly and
 * the answer simply is not in yet.
 *
 * `disabled` is one the user switched off in the CLI's own configuration, which
 * geniro cannot undo (cursor's `mcp disable`); it is distinct from the wire's
 * `disabled` flag, which also covers servers geniro itself suppressed.
 *
 * `needs_auth` is an OAuth server the CLI has no stored credentials for. It is
 * NOT a failure and must not read as one: nothing is broken, the user has
 * simply never signed in, and the fix is one command rather than a
 * configuration hunt. It earned its own arm because it is the only status with
 * an ACTION attached — see `AdapterConfig.mcp.loginArgs`. Folded into `failed`
 * it would have been listed among things to debug; left as `unknown` (where the
 * missing marker put it, probe-verified on claude 2.1.223) the row said nothing
 * at all and offered nothing to do.
 */
export type AgentMcpServerStatus =
  | 'connected'
  | 'failed'
  | 'pending'
  | 'loading'
  | 'disabled'
  | 'needs_auth'
  | 'unknown';

/**
 * One MCP server a CLI agent loads in a given working directory.
 *
 * The set is per-CLI AND per-folder: a CLI resolves project-scoped servers
 * relative to the directory it runs in, so the same agent answers differently
 * in two folders and two agents answer differently in one.
 */
export interface AgentMcpServer {
  name: string;
  /**
   * The command line or URL the CLI reaches the server through, or null when
   * the CLI does not say.
   *
   * Nullable because not every CLI reports it: claude prints
   * `sentry: node s.js - √ Connected`, cursor prints `sentry: ready` and
   * nothing more (probe-verified on 2026.07.23-e383d2b). Reading the CLI's own
   * config file to fill the gap is out of scope — the CLI is the source of
   * truth here, for both agents alike — so null is the honest answer. An empty
   * string would have asserted a command that was never reported, which is the
   * empty-vs-unknown collapse the discriminated result below exists to prevent.
   */
  target: string | null;
  /** Null for the same reason as {@link AgentMcpServer.target}. */
  transport: 'stdio' | 'http' | 'sse' | null;
  status: AgentMcpServerStatus;
  /**
   * The failure reason, or what the server is waiting for — whatever the CLI
   * printed after the status. Null when the status says everything.
   */
  detail: string | null;
}

/**
 * The outcome of asking one CLI for its MCP servers.
 *
 * Discriminated rather than a bare array because an empty array cannot say
 * WHY it is empty, and the three reasons need different words in front of the
 * user: the folder genuinely has none, this CLI has no listing at all, or the
 * CLI could not be reached just now. Collapsing them loses the only
 * distinction the panel exists to make — and, worse, lets a transient failure
 * be cached and shown as "no servers configured".
 *
 * Same shape as {@link TerminalCommandResult}, for the same reason: an adapter
 * reports its refusal as data and the owning module decides how to say it.
 */
export type AgentMcpListingResult =
  { ok: true; servers: AgentMcpServer[] } | { ok: false; reason: string };

/** Everything an adapter needs to list the MCP servers it would load. */
export interface AgentMcpServersInput {
  /**
   * The folder to list in, already validated and canonicalized.
   *
   * Which servers a folder contributes is the CLI's own business: for claude,
   * a project `.mcp.json` is visible ONLY from its own folder (probe-verified
   * on 2.1.220), so listing from a folder that has none yields the
   * folder-INDEPENDENT set — exactly what the graph builder wants, since a
   * workflow has no folder until it runs.
   */
  cwd: string;
  /**
   * The agent config directory this listing is about, already validated and
   * canonicalized. Absent: list under the CLI's default profile.
   *
   * Part of the question, not a decoration: a CLI keeps its configured MCP
   * servers in that directory, so two profiles in one folder genuinely load
   * different sets — and a listing taken under the wrong one describes servers
   * the turn will never start.
   */
  configDir?: string | null;
}

/** Which ONE server's health is being asked about, and where. */
export interface AgentMcpServerHealthInput extends AgentMcpServersInput {
  /** The server's name, as the CLI's own listing spells it. */
  server: string;
}

/**
 * One conversation this CLI already holds on this machine, offered so the user
 * can carry it on inside geniro instead of only in their terminal.
 *
 * Deliberately four fields and no more: everything here has to be answerable by
 * BOTH a disk scan and a protocol call, since that is how the two shipped CLIs
 * differ (claude keeps a JSONL transcript per session; cursor answers ACP
 * `session/list`). A field only one of them can fill would render as a blank
 * column for the other rather than as a fact.
 */
export interface AgentSessionRecord {
  /**
   * The id this CLI resumes by — `claude --resume <id>`, ACP `session/load`.
   * Opaque here on purpose: only the adapter that produced it may interpret it.
   */
  id: string;
  /**
   * The folder the conversation ran in, or null when the CLI records none.
   *
   * Load-bearing rather than decorative: a resumed turn runs SOMEWHERE, and
   * running an agent's continuation in a different project than the one it was
   * reasoning about is how a resume produces confident nonsense. The importer
   * opens the new chat in this folder, so a session with none cannot be offered.
   */
  cwd: string | null;
  /**
   * One line naming the conversation, or null when nothing names it.
   *
   * The CLI's own title where it has one (cursor generates them), else the
   * opening prompt — which is why this is a plain string and not a "title"
   * with a separate "preview": a picker row can only show one line, and the
   * adapter is what knows which line its CLI can produce.
   */
  title: string | null;
  /** When it was last written, epoch ms; null when the CLI records none. */
  updatedAt: number | null;
  /**
   * The line of the conversation that answered the search, or null.
   *
   * Only ever set for a match found in the BODY rather than in the title or the
   * folder, and it exists because without it a content search is unreadable:
   * the row still shows the conversation's opening prompt, which has nothing to
   * do with the words that were typed, so a list of correct matches looks like
   * a list of irrelevant ones. Null when a query named nothing this session's
   * body had to answer for — the title or the path already says why it is here.
   */
  snippet: string | null;
}

/**
 * The answer to {@link AgentAdapter.listSessions} — the rows, and the reason
 * there are none.
 *
 * Same shape and same rule as the MCP listing: "this CLI holds no sessions" and
 * "this CLI cannot be asked" are both an empty array, and a reader that cannot
 * tell them apart either invents an explanation or branches on which CLI it is
 * holding. Only `sessions: []` with a NULL reason asserts that there is nothing
 * to resume.
 */
export interface AgentSessionListing {
  sessions: AgentSessionRecord[];
  unavailableReason: string | null;
  /**
   * What THIS listing did not reach, or null when it reached everything.
   *
   * The dynamic twin of `AdapterConfig.sessions.listingPartialReason`, which is
   * a standing fact about the CLI. This one is a fact about the call: a content
   * search is bounded in files and in bytes per file, so on a large profile it
   * genuinely stops short — and a search that quietly gives up looks exactly
   * like a search that found everything there was.
   */
  partialReason: string | null;
}

/** Everything an adapter needs to list the conversations it holds. */
export interface AgentSessionsInput {
  /**
   * Only sessions from this folder, or null for every folder the CLI
   * remembers. Canonicalized by the caller when present.
   */
  cwd: string | null;
  /**
   * The config directory to read, or null for the CLI's own default profile.
   *
   * Part of the question, exactly as it is for MCP servers: a CLI keeps its
   * conversations inside its profile, so a second account holds a different set
   * — and an id listed under one profile is not resumable under another.
   */
  configDir: string | null;
  /** Most rows to return, newest first. */
  limit: number;
  /**
   * What the user typed into the picker's search box, or null for none.
   *
   * Answered HERE rather than filtered by the caller, and that is the whole
   * point of it being on the input: only the adapter can reach what its CLI
   * actually stores, so only the adapter can match on what was SAID in a
   * conversation rather than on the one line the row happens to show. An
   * adapter that cannot reach the body still honours the query against the
   * title and the folder — every implementation must apply it, or a search
   * would silently widen back to everything on that CLI — and declares the
   * shortfall in `AdapterConfig.sessions.contentSearchUnavailableReason`.
   *
   * Whitespace-separated terms, ALL of which must match, each anywhere in the
   * session: that is how somebody actually remembers a thread from last week —
   * in fragments, one from the project and one from what was said.
   */
  query: string | null;
}

/** Which conversation is being taken over, and from where. */
/**
 * The exchange a conversation is to be NAMED from.
 *
 * The text rather than the run, because an adapter must not read this app's
 * database — and rather than a session id, because a CLI that has to be ASKED
 * for a title is one whose own store holds none.
 */
export interface AgentTitleInput {
  /** What the user opened the conversation with. */
  opening: string;
  /** What the agent answered, when it has answered. */
  reply: string | null;
  /**
   * The conversation as it stands NOW — the newest exchange — or null on the
   * first ask, when it would only repeat {@link opening} and {@link reply}.
   *
   * The opening is not always nameable: measured on 2.1.237, a chat opened
   * with a bare Slack link is answered "I need to see the Slack thread to
   * understand what work you're asking about…", because there genuinely is
   * nothing in it to name. Re-asking with the same two messages reproduces the
   * same refusal, so a retry is worth making only if it carries what the
   * conversation has said since.
   */
  latest: string | null;
  /** The profile the run belongs to; null = the CLI's default. */
  configDir: string | null;
}

export interface AgentSessionImportInput {
  /** The id, as {@link AgentSessionRecord.id} spelled it. */
  sessionId: string;
  /** The profile it was listed under; null = the CLI's default. */
  configDir: string | null;
  /**
   * The folder the conversation ran in, as the listing reported it.
   *
   * Here rather than derived, because an adapter that reaches the CLI to do
   * this has to ROOT it somewhere: ACP's `session/load` takes a cwd, and
   * reading a conversation about one project while rooted in another is how a
   * resumed thread starts reasoning about the wrong tree.
   */
  cwd: string;
}

/**
 * A conversation read back out of a CLI's own record — the answer to
 * {@link AgentAdapter.readSessionHistory}.
 */
export interface AgentSessionHistory {
  /**
   * The events, OLDEST FIRST, in the same vocabulary a live turn produces — so
   * an imported transcript goes through the one `mapEventToItem` every other
   * row in the app already passes through, rather than a second row builder
   * that could render the same message differently.
   */
  events: AgentEvent[];
  /**
   * How many earlier rows were left out to honour the caller's limit; 0 when
   * the whole conversation is here.
   *
   * Stated rather than silent, on the rule the workflow executor's dropped
   * settings follow: a transcript that begins mid-conversation with nothing
   * saying so is a transcript that lies about what the agent was told.
   */
  droppedBefore: number;
}

/**
 * One server's health as the CLI just reported it — the answer to
 * `AgentAdapter.readMcpServerHealth`.
 *
 * Deliberately the same two fields a listed row carries, so a caller can drop
 * it straight onto a row rather than translating; `detail` is the CLI's own
 * sentence about the state, or null when it gave none.
 */
export interface AgentMcpServerHealth {
  status: AgentMcpServerStatus;
  detail: string | null;
}

/**
 * Where a server came from, which is what decides whether geniro may switch it
 * off at all.
 *
 * `project` — defined in the folder's own MCP config, and the ONLY scope any
 * verified mechanism can disable. Everything else is `other`: user- and
 * local-scope servers have no non-destructive disable on claude 2.1.220
 * (probe-verified), so a control for them would be a switch that does nothing.
 *
 * `unknown` is not "probably other" — it is a CLI whose config layout has not
 * been verified, and it renders read-only for the same reason.
 */
export type AgentMcpServerScope = 'project' | 'other' | 'unknown';

/**
 * What a CLI's own config files say about a folder, beyond the health listing.
 *
 * They exist because the LISTING cannot answer either question: `claude mcp
 * list` reports a disabled server as though it were live, and prints no scope
 * at all (probe-verified on 2.1.220/2.1.222).
 */
export interface AgentMcpFolderFacts {
  /**
   * Every server name this folder's config DEFINES, across every scope — read
   * from the CLI's own files, so it costs no dial.
   *
   * It is what the panel shows while the dial is still running. Listing a
   * server means STARTING it (`claude mcp list` boots each one), measured here
   * at ~1.1s per server — 17s for a 15-server profile, 27s for a 47-server
   * one — and until this existed the panel had nothing to draw for that whole
   * stretch: a spinner over an empty box, which is indistinguishable from a
   * folder with no servers and from a read that died.
   *
   * Names ONLY, and that limit is the point: a name is knowable without
   * running anything, health is not. A row built from this carries `loading`
   * until the dial answers, which is the one honest thing to say about a
   * server nobody has dialled yet.
   */
  readonly configured: readonly string[];
  /**
   * Server names this folder currently has switched OFF, as the CLI's OWN
   * config records it — the state a `/mcp` panel in the user's terminal shows.
   *
   * The toggle geniro offers writes that same list, so this is not "what
   * geniro turned off" but "what is off", however it got that way.
   */
  readonly disabled: readonly string[];
  /**
   * Server names that are off in a way geniro CANNOT undo — a rejection the
   * user (or the CLI's own trust prompt) recorded, whose every source copy is
   * UNIONed rather than overridden (probe-verified on claude 2.1.220).
   *
   * A row listed here gets no switch: offering one would be a control that
   * silently does nothing, which is exactly what the design forbids.
   */
  readonly lockedOff: readonly string[];
  /**
   * Where each server the folder resolves was DEFINED, keyed by name. A name
   * this CLI cannot place is simply absent, which reads as `unknown`.
   *
   * Its whole reason for existing is that a CLI merges its scopes BY NAME, so
   * a listing is one row per name and cannot say which definition won.
   * Measured on cursor 2026.08.11-e8db854 in a folder defining `codegraph` at
   * both scopes: `mcp list` prints one `codegraph` row, the workspace file's
   * definition is the one in force, and `mcp list-tools codegraph` answers
   * `MCP server "codegraph" has not been approved` — while the user-scope
   * server of that name works everywhere else on the machine. With no origin
   * on the row, the panel showed a server the reader knows to be working and
   * called it unapproved, with nothing on screen to explain the contradiction.
   */
  readonly origins: Readonly<Record<string, AgentMcpOrigin>>;
  /**
   * This folder's answer to `AdapterConfig.mcp.interactiveOnlyNote`, when the
   * CLI's own-app-only servers can only be known by looking at the machine;
   * null leaves the config's static sentence standing.
   *
   * It exists because cursor's are its PLUGINS — a set the user installs and
   * changes — so no string written here could name them. claude's are two
   * fixed built-ins and stay in the config.
   */
  readonly interactiveOnlyNote: string | null;
}

/** Which of a CLI's configuration scopes a server was defined in. */
export type AgentMcpScope = 'user' | 'workspace' | 'unknown';

/** Where one server came from, and what it displaced getting there. */
export interface AgentMcpOrigin {
  readonly scope: AgentMcpScope;
  /**
   * True when a WORKSPACE definition overrides a same-named user one.
   *
   * Reported separately from the scope because the two answer different
   * questions, and only this one explains a surprise: the user's own server is
   * fine, and is simply not what this folder loads under that name.
   */
  readonly shadowsUser: boolean;
}

/** Everything an adapter needs to list what it can be invoked with. */
/**
 * Which account a model listing is ABOUT.
 *
 * A model vocabulary is an account fact — the subscription decides which models
 * exist — and the account is the config directory, so the listing cannot be
 * asked without one. A CLI whose account is not a directory ignores it and says
 * so in its own `configDir.unavailableReason`.
 */
export interface AgentModelsInput {
  /** The run's config directory (its ACCOUNT), or null for the CLI's own. */
  configDir: string | null;
}

export interface AgentSkillsInput {
  /** The user's project folder, already validated and canonicalized. */
  cwd: string;
  /** The "user" scan root — the real home dir outside tests. */
  homeDir: string;
  /**
   * The run's config directory (its ACCOUNT), or null for the CLI's own.
   *
   * It REPLACES {@link homeDir} as the user-scope root rather than adding to
   * it, because that is what the mechanism does — see `AgentAdapter.listSkills`.
   */
  configDir: string | null;
}

/**
 * How a utility child was spawned, handed to the registration site so it can
 * reap exactly what exists. Produced by `runCommand`, consumed by
 * `childProcessHandle` — the two halves of the process-group pairing, which is
 * why neither is stated by hand at a call site.
 */
export interface AgentSpawnInfo {
  /** The child leads its own process group (see {@link AgentCommandOptions.processGroup}). */
  processGroup: boolean;
}

/** Options for a short-lived utility command a CLI is asked to run. */
export interface AgentCommandOptions {
  /**
   * Handed the spawned child so the caller can register it with
   * `ProcessRegistry` — every child the daemon spawns must be reapable on
   * shutdown, including these one-shot utility ones.
   *
   * `spawnInfo` describes what was ACTUALLY spawned, so the registration site
   * never has to restate it: `childProcessHandle(child, spawnInfo)` is always
   * correct, whereas a hand-written `{ processGroup: true }` at the call site
   * could disagree with the spawn and silently reap nothing.
   */
  onSpawn?: (child: ChildProcess, spawnInfo: AgentSpawnInfo) => void;
  /**
   * Handed a full TURN a utility method started (a probe), for the same
   * reason as `onSpawn` — `start()` hands back a handle, not a child, so the
   * two registration seams are separate.
   */
  onTurn?: (handle: AgentTurnHandle) => void;
  timeoutMs?: number;
  /**
   * The folder to run the command in. Absent means the daemon's own cwd, which
   * is what every caller wanted until a command's ANSWER became folder-scoped:
   * `claude mcp list` reports the project's `.mcp.json` servers and the
   * local-scope servers keyed to that directory, so asked from the wrong place
   * it confidently returns a different machine-true list.
   */
  cwd?: string;
  /**
   * Run the child as its own process-group leader, and reap the whole group on
   * every abnormal exit.
   *
   * THE canonical statement of this option; the other sites that touch it point
   * here rather than restating it. Off by default because it is only worth its
   * cost for a command that FORKS: `claude mcp list` health-checks, so it
   * launches the user's own MCP servers as grandchildren, and `kill-tree.ts`
   * names the failure this closes — "a single-PID kill would orphan them".
   *
   * Setting it moves the command off `execFile` entirely, onto `spawn` with
   * `detached` plus a group-killing deadline of our own. That is not an
   * implementation detail worth hiding: `execFile` forwards only
   * cwd/env/uid/gid/shell/windows* to `spawn` and silently drops `detached`,
   * so an `execFile` child can never lead a group no matter what its options
   * bag says, and the reap addresses nobody.
   *
   * `runCommand` owns both halves: it passes the same flag to `onSpawn` as
   * `spawnInfo.processGroup`, so a registration site cannot pair them wrongly.
   */
  processGroup?: boolean;
  /**
   * Resolve with the command's OUTPUT — stdout AND stderr — whatever its exit
   * status, instead of the usual `null`-on-failure.
   *
   * THE canonical statement of this option. Off by default, because for almost
   * every utility command a non-zero exit means the answer is worthless. It
   * exists for the commands where the answer IS the failure: `cursor-agent mcp
   * list-tools <server>` exits 1 and writes `MCP 'figma' requires
   * authentication.` to STDERR — measured on 2026.08.11-e8db854 — so the one
   * reading that distinguishes "needs signing in" from "broken" is invisible to
   * a caller that only sees stdout on success.
   *
   * Both halves are needed together and neither is useful alone here, which is
   * why this is one flag and not two: the diagnosis is on the failure path and
   * it is on stderr.
   *
   * With it set, `null` narrows to "could not be run at all" — a spawn that
   * threw, a deadline, or output past the buffer cap. Parsing therefore has to
   * be marker-based rather than exit-code-based, which is what the CLIs'
   * prose-only output forces anyway.
   */
  captureDiagnosis?: boolean;
  /**
   * Extra env for THIS command's child, merged over `buildChildEnv()`.
   *
   * A utility command can be as profile-scoped as a turn is: `claude mcp list`
   * reads the servers configured in whatever config directory it runs under,
   * so asked without the run's own it confidently answers about a different
   * account. The same stripping applies either way — this only ADDS, it never
   * reinstates a key `buildChildEnv` removed on purpose.
   */
  env?: Record<string, string>;
  /**
   * Written to the child's stdin verbatim, in order, immediately after the
   * spawn — framing included, so a JSON-RPC caller passes `encodeRequest`
   * output straight through rather than having this option guess at delimiters.
   *
   * For a utility command that must be TALKED to rather than merely read — an
   * ACP handshake, whose answer only exists once two JSON-RPC frames have gone
   * in. Setting it IMPLIES {@link AgentCommandOptions.processGroup}: `runCommand`
   * routes to the group path whenever this or `settleWhen` is present, because
   * that is the only path spawning a writable stdin pipe, and an `execFile`
   * child would drop every frame silently.
   *
   * Written without awaiting a reply between them, because a JSON-RPC server
   * reads one ordered stream — see {@link AgentCommandOptions.settleWhen} for
   * what ends the read.
   */
  stdinWrites?: readonly string[];
  /**
   * Stop reading as soon as the accumulated stdout answers the question, and
   * settle with it.
   *
   * Without it a conversational command never finishes: probed on cursor-agent
   * 2026.08.04-aaa8809, `cursor-agent acp` does NOT exit when its stdin closes,
   * so waiting for `close` spends the whole deadline and then reports the
   * failure of a read that had succeeded in under a second.
   *
   * Absent means the existing behaviour, unchanged: read to `close` and settle
   * on the exit status. Setting it implies `processGroup`, exactly as
   * {@link AgentCommandOptions.stdinWrites} does and for the same reason.
   */
  settleWhen?: (stdout: string) => boolean;
  /**
   * Give the child a real TERMINAL on stdin, so a CLI that refuses a pipe will
   * run at all.
   *
   * For exactly one shape of command: an interactive flow the daemon can
   * otherwise only hand to the user's terminal. `claude mcp login <server>`
   * is the case — probe-verified on 2.1.232 that with stdin a pipe it answers
   * `stdin isn't a terminal, so authentication can't be completed here` and
   * exits BEFORE printing anything, while under a pty it prints the
   * authorization URL, opens the browser and serves its own
   * `http://localhost:<port>/callback`. So the terminal window geniro used to
   * open for it was never the mechanism, only the way to get a TTY.
   *
   * Implemented with `script(1)` (macOS/BSD: `script -q /dev/null <cmd> …`),
   * NOT a native pty module: `node-pty` was deliberately deleted with the PTY
   * mirror in M4, and re-adding a native dependency — with its Electron-ABI
   * rebuild — to allocate one terminal for one sign-in is a poor trade.
   * `script` ships with macOS and was measured to give the child
   * `process.stdin.isTTY === true`.
   *
   * Implies {@link AgentCommandOptions.processGroup}: the wrapper is a process
   * of its own with the CLI under it, and a browser opener under THAT, so the
   * only reapable unit is the group.
   *
   * Two consequences the caller owns. The child's stdout is TERMINAL output —
   * it carries ANSI escapes and CR line endings, so anything parsing it must
   * tolerate them. And an exit status is the WRAPPER's, so a caller that needs
   * the CLI's own verdict must read it out of the output.
   */
  pty?: boolean;
}

/**
 * The tool-approval modes a caller may ask for. The vocabulary is shared, but
 * which of them a given CLI honours is not — see
 * {@link AdapterConfig.approval}.modes.
 */
export type AgentApprovalMode = 'auto' | 'ask' | 'acceptEdits' | 'plan';

/**
 * What the daemon's probes have established about the INSTALLED CLIs, as an
 * adapter reads it.
 *
 * Structurally the subset of the `GET /v1/capabilities` wire shape that
 * adapters care about, declared HERE rather than imported: `CapabilitiesWire`
 * lives in the graphs module, which imports this one, and an adapter reaching
 * back across that edge would invert the dependency. Structural typing means a
 * consumer holding the full wire object can pass it straight in.
 *
 * The fields are per-CLI by nature — a probe result belongs to the binary it
 * probed — but no CONSUMER has to know which adapter reads which field: it
 * hands the whole bag to `AgentAdapter.approvalSupportFrom` and each adapter
 * takes its own.
 */
export interface InstalledCapabilities {
  claudeModes: ClaudeModesCapability;
}

/**
 * What a per-binary probe established about the INSTALLED CLI's approval
 * modes, in terms no consumer has to know a CLI to build.
 *
 * Tri-state per mode, and the distinction is load-bearing: `false` means a
 * probe PROVED this binary rejects the mode (degrade it), while absent means
 * nobody asked (keep the requested mode, so a genuine rejection still surfaces
 * loudly from the CLI itself instead of being pre-empted by a guess).
 */
export interface InstalledApprovalSupport {
  supported: Partial<Record<AgentApprovalMode, boolean>>;
}

/** The mode a turn actually runs under, and what the transcript owes the user. */
export interface ApprovalResolution {
  mode: AgentApprovalMode;
  /**
   * Null when the requested mode survived; otherwise the one line explaining
   * what the turn runs as instead, and why. The caller persists it as a system
   * item — a degrade the user cannot see reads as enforced permissions that
   * never were.
   */
  degradeReason: string | null;
}

/** Everything an adapter needs to drive one turn. */
export interface AgentTurnInput {
  /** The user's message text for this turn. */
  prompt: string;
  /**
   * Images the user attached to this turn's message, already on disk under the
   * daemon's attachments dir. Delivery is adapter-specific: claude gets real
   * base64 image content blocks in its stream-json stdin payload (probe-verified
   * on 2.1.220 — the model describes the image without touching a tool), while
   * a CLI whose stdin is plain text can only be told the paths and left to open
   * them itself. Empty/absent for a text-only turn.
   */
  images?: TurnImage[];
  /**
   * Working directory the CLI runs in — the user's project folder. The chat
   * service validates this exists and is a directory before the adapter spawns,
   * so the agent is scoped to the user's project, never the daemon's own cwd.
   */
  cwd: string;
  /** Model alias/name (adapter-specific); null/undefined = the CLI default. */
  model?: string | null;
  /**
   * How hard the model should think this turn, spelled as the CLI spells it
   * (one of {@link AgentAdapter.listEfforts}); null/undefined = the CLI's own
   * default, no flag.
   *
   * A plain string rather than a union, for the same reason as `model`: the
   * vocabulary is per-CLI, so a fixed enum here would put one CLI's facts in
   * the shared contract. The caller validates against the adapter's list; an
   * adapter whose CLI has no such control ignores the field entirely.
   */
  effort?: string | null;
  /**
   * Which of the model's context-window sizes to run at, spelled as the CLI
   * spells it (one of {@link AgentAdapter.listModelContextWindows});
   * null/undefined = whatever the model's own default is.
   *
   * A per-model PARAMETER rather than a property of the conversation, exactly
   * like `effort` and carried the same way for the same reason — the vocabulary
   * belongs to the CLI, and an adapter whose CLI has no such control ignores
   * the field.
   */
  contextWindow?: string | null;
  /**
   * Every OTHER model setting this turn asks for, keyed by the CLI's own
   * parameter id (`{optimize_for: 'intelligence'}`).
   *
   * A pass-through in the strictest sense: geniro holds no vocabulary for these
   * (see `AgentModelParameter`), so an adapter either knows how to set a config
   * option on its CLI or ignores the field entirely — which is what the base
   * and the claude adapter both do.
   */
  modelParameters?: Record<string, string> | null;
  /** Prior CLI session id to resume; null/undefined starts a fresh session. */
  resumeSessionId?: string | null;
  /**
   * Role/system prompt for this turn (graph nodes). Claude appends it to the
   * CLI system prompt (`--append-system-prompt`); ACP has no such parameter,
   * so its driver prepends it to the prompt text. Undefined for plain chat.
   */
  systemPrompt?: string | null;
  /**
   * The user's own global custom instructions, as snapshotted onto the run.
   *
   * Kept SEPARATE from {@link systemPrompt} for the same reason
   * {@link callSurfacePrompt} is: the two answer different questions and rank
   * differently. `systemPrompt` is what THIS turn is for — a graph node's role
   * — while this is a standing preference the user set once for every agent, so
   * a node's role has to outrank it. Folding them into one field would make
   * that ordering the caller's problem, and the graph path would have to
   * hand-join a string it did not author.
   *
   * Reaches the CLI through `AgentAdapter.composeSystemPrompt` like every other
   * part, so it needs no per-CLI delivery of its own — both shipped adapters
   * already route that one composed block to their own channel.
   *
   * Undefined for a run created before the setting existed, and for one whose
   * user has typed nothing.
   */
  customInstructions?: string | null;
  /**
   * The instruction blocks wired to this graph node, already joined by the
   * executor. Undefined for plain chat and for a node nothing is wired to.
   *
   * A THIRD peer beside {@link systemPrompt} and {@link customInstructions};
   * `composeTurnInstructions` owns where it ranks between them.
   *
   * Joined by the executor rather than sent as a list, because the ORDER of
   * several blocks is a graph fact (the wiring) that no adapter can recover.
   */
  instructionBlocks?: string | null;
  /**
   * Run every turn at the largest window the agent can give it, where the
   * agent HAS such a switch.
   *
   * Named for cursor's own product feature because that is what a user reads
   * on the setting, and because the capability wire already names a CLI where
   * one owns the concept (`claudeModes`). It stays a fact about the TURN and
   * not about a CLI: an adapter with no such switch ignores it, and nothing
   * outside `adapters/cursor-acp/` reads it.
   *
   * `undefined` means the caller did not say — an adapter reads its own
   * default, never `false`. That distinction is what keeps runs created before
   * the setting existed at the window they have always run at.
   */
  cursorMaxMode?: boolean;
  /**
   * This turn is geniro's OWN bookkeeping — its output is parsed by the daemon
   * and never rendered in a transcript anybody reads.
   *
   * What it withholds is the host preamble
   * ({@link GENIRO_UI_PREAMBLE}, added by `AgentAdapter.composeSystemPrompt`):
   * that text describes the surface a REPLY lands on, and for a probe there is
   * no such surface, so sending it states something untrue and pays argv for
   * it on every capability read. Adapter-agnostic like {@link trustWorkspace}
   * and {@link isolateMcpServers} — the caller states what the turn IS, and
   * the composition decides what that costs.
   *
   * Deliberately NOT folded into `isolateMcpServers`, which every internal
   * probe happens to set today: that field is about which MCP servers load,
   * and a later internal turn that legitimately wants the user's servers would
   * silently regain the preamble if the two were one flag.
   *
   * A user-project turn NEVER sets it.
   */
  internalProbe?: boolean;
  /**
   * This turn IS the command-list probe (`AgentAdapter.listReportedCommands`).
   *
   * Says what the turn is, never what a CLI should do about it: an adapter
   * whose CLI announces its commands unasked ignores this, and one that has to
   * ASK reads it as its cue. Claude is the second kind — its `system/init`
   * names every command and describes none, and only a `reload_skills` control
   * request gets the sentences — so a flag was needed that the probe can set
   * without knowing why any particular CLI wants it.
   *
   * Deliberately NOT folded into {@link internalProbe}, which several probes
   * set: reading it as "the command probe" would have the permission-mode
   * probe reload the user's skills as a side effect of asking about modes.
   */
  commandListProbe?: boolean;
  /**
   * The caller's "May call" awareness block, naming each callee reachable
   * through `mcpEndpoint`'s tools. Kept SEPARATE from `systemPrompt` because
   * it is only true while the call tools are actually registered: an adapter
   * that ends up withholding the endpoint (an ACP agent that does not
   * advertise HTTP MCP support) must drop this block too, or the agent is
   * instructed to route work through tools it does not have. Join the two
   * with `AgentAdapter.composeSystemPrompt`, never by hand — it composes four
   * parts now (the host preamble and {@link customInstructions} ahead of these
   * two), and their order is the precedence rule.
   */
  callSurfacePrompt?: string | null;
  /**
   * Tool-approval mode. `ask` blocks each permission-gated tool call on a
   * user verdict (elicitation card); `acceptEdits` auto-approves file edits
   * and asks for everything else; `plan` (chat-only) has the agent plan
   * without executing; `auto` runs unattended with permission checks
   * bypassed. Undefined (legacy chat rows) keeps the CLI's own defaults —
   * no extra permission flags.
   */
  approvalMode?: AgentApprovalMode;
  /**
   * Extra environment merged over `process.env` for the child process — e.g. a
   * per-run `CLAUDE_CONFIG_DIR`, or the `CURSOR_API_KEY` that
   * `CursorAcpAdapter.buildEnv` re-injects for its own child.
   *
   * Nothing here is sourced from a geniro-held secret any more: the app stores
   * no credentials at all now that both CLIs authenticate from their own login
   * state. A value that IS a credential is one the user exported in their own
   * shell, and it reaches exactly the one child entitled to it — never SQLite.
   */
  env?: Record<string, string>;
  /**
   * Stream this turn's assistant text as it is generated, if the CLI can.
   *
   * Adapter-agnostic intent, like {@link allowUserQuestions}: the caller says
   * "someone is watching", each CLI decides what that costs. A CLI with no
   * partial-output mode ignores it and streams whole blocks as before.
   */
  streamPartials?: boolean;
  /**
   * This turn may stop and ASK THE USER a question.
   *
   * Adapter-agnostic on purpose: the caller states the intent, and each CLI
   * decides what (if anything) it costs. For claude it is load-bearing —
   * `--dangerously-skip-permissions` strips the AskUserQuestion tool entirely
   * (probe-verified), so an `auto` turn that wants the question channel must
   * spawn on the stdio permission dialogue instead and have the DAEMON stand
   * in for the bypass, auto-approving plain permission requests. A CLI with no
   * question channel ignores this and spawns exactly as before.
   */
  allowUserQuestions?: boolean;
  /**
   * Trust the turn's cwd without prompting (cursor `--trust`, headless-only).
   * Needed when the cwd is a daemon-created directory the user never opened —
   * the MCP-trust probe's temp workspace. User-project turns never set it:
   * trusting the user's own worktree is the user's decision, not the daemon's.
   */
  trustWorkspace?: boolean;
  /**
   * This turn must load NO MCP servers of the user's.
   *
   * Adapter-agnostic intent, like {@link trustWorkspace}: the caller states
   * that nothing about this turn depends on the user's servers, and each CLI
   * decides how to arrange that. Set only by probes the daemon runs for its
   * own bookkeeping — the reported-commands probe is cancelled before the
   * model runs, so a server it launched could never have been used, yet
   * launching one costs a real process and reaping it costs the user's own
   * server on that folder.
   *
   * A user-project turn NEVER sets it: an agent must see the same MCP servers
   * a fresh session in that folder sees. A CLI with no way to restrict the set
   * ignores the field.
   */
  isolateMcpServers?: boolean;
  /**
   * The directory this turn's CLI keeps its OWN state in — credentials,
   * settings, installed plugins, session history. Absent: the CLI's default
   * profile (`~/.claude`).
   *
   * This is how one run talks to a different ACCOUNT (a different
   * subscription) with a different toolbelt, without touching the user's
   * default profile: it is one directory, and everything the CLI reads about
   * itself is inside it.
   *
   * Already validated and canonicalized by the caller — an adapter hands it
   * straight to its CLI and must never be the thing that first checks it. It
   * travels as ENV, not argv (claude reads `CLAUDE_CONFIG_DIR`), which is why
   * an adapter maps it in `buildEnv` rather than in `buildArgs`.
   *
   * A CLI with no such mechanism declares that in
   * `AdapterConfig.configDir.unavailableReason` and simply ignores the field.
   */
  configDir?: string | null;
  /**
   * Loopback MCP endpoint granting this turn the agent-call tools
   * (call_agent / await_agent / answer_agent). Delivery is adapter-specific —
   * claude gets a per-turn config file referenced by `--mcp-config` (the
   * token travels IN the 0600 file, never argv); the ACP adapter sends it as
   * an HTTP header inside a `session/new` stdin frame. Absent or null: the
   * turn gets no call tools.
   */
  mcpEndpoint?: {
    url: string;
    token: string;
    /**
     * The name geniro's own MCP server is published under for this turn.
     *
     * The ACP path uses it verbatim (per-run, so no project server can
     * collide). Claude currently IGNORES it and publishes under the shared
     * {@link GENIRO_MCP_SERVER_KEY}, because the renderer drops geniro's own
     * call tools from the transcript by matching that fixed prefix. Since
     * `--strict-mcp-config` is no longer passed, `prepareTurn`'s
     * `definesGeniroServer` guard stands in for the uniqueness this field
     * gives ACP for free.
     */
    serverName: string;
    /** Override for the CLI's MCP tool timeout (sync calls run minutes). */
    toolTimeoutMs?: number;
  } | null;
}

/**
 * One CLI process, and the turns an adapter runs on it.
 *
 * Every turn goes through a session — including the ordinary one-turn kind, so
 * there is a single code path rather than a branch on which CLI is being
 * talked to. A CLI that cannot host more than one turn per process simply
 * yields a session whose SECOND {@link AgentSession.startTurn} answers null,
 * which is the same answer a caller gets for a session that has died or whose
 * argv no longer fits — and it means exactly one thing everywhere: spawn a
 * fresh one.
 *
 * Why a session exists at all: a CLI boots the user's MCP servers when it
 * starts, and an MCP server can own something expensive — a browser the user
 * is logged into. A process per turn tears that down on every message.
 */
export interface AgentSession {
  /**
   * Open a turn on this process. Null when this session cannot serve it: the
   * process is gone, a turn is already in flight, this CLI hosts one turn per
   * process, or the input would need different argv than the process was
   * spawned with (a changed model, folder or config directory).
   */
  startTurn(
    input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
  ): AgentTurnHandle | null;
  /**
   * Put a question to this live process on its own stdin control channel,
   * outside any turn — the session-level half of `CliSession.ask`, exposed
   * because an adapter may need it to answer about the PROCESS rather than
   * about a turn.
   */
  ask<T>(request: SessionAsk<T>): Promise<T | null>;
  /** Alive, with no turn in flight — ready to take another one. */
  readonly idle: boolean;
  /** The process has not been observed to end. */
  readonly alive: boolean;
  /**
   * Alive and idle, but `startTurn` will refuse every further turn — the last
   * turn was ended for the CLI rather than by it, so this process may still be
   * printing that turn's tail and nothing can tell it apart from a new turn's
   * output.
   *
   * Deliberately NOT folded into `idle`: every reader treats a non-idle session
   * as BUSY, which would stop the idle reaper from ever closing this one while
   * still counting it against the session ceiling. A holder must instead close a
   * retired session on sight, the way it closes a dead one.
   */
  readonly retired: boolean;
  /**
   * Alive and idle, and yet not free: the CLI is standing still on a verdict
   * only the user can give, raised (or held) between turns.
   *
   * The one reader is whoever REAPS an unused session. A person taking twenty
   * minutes over a question is not a chat going unused, and closing the process
   * under them reaches the CLI as a refusal of that question — which is how a
   * run came to be marked failed, with a bare "claude run failed" for a question
   * that had never been put on screen.
   */
  readonly parked: boolean;
  /**
   * Terminate the process group — the CLI plus every tool/MCP grandchild.
   *
   * This is the ONLY thing that stops a run-scoped process, so whoever holds
   * the session owns that obligation: nothing else will reap it.
   */
  close(): void;
  /** Resolves once the process is gone. Never rejects. */
  readonly closed: Promise<void>;
}

export type TurnStdin = (payload: string) => boolean;

/** The two channels a {@link TurnDriver} owns for the turn it is driving. */
export interface TurnIo {
  write: TurnStdin;
  emit: (event: AgentEvent) => void;
}

/**
 * Per-turn protocol state for ONE turn of one CLI.
 *
 * The default driver (built by `AgentAdapter.createTurnDriver`) is stateless:
 * it just forwards each parsed stdout line to the adapter's `mapMessage`, which
 * is all a one-shot stream-json CLI needs. An adapter whose CLI speaks a
 * STATEFUL, bidirectional protocol — ACP's JSON-RPC handshake, where the next
 * message to send depends on the last one received — overrides
 * `createTurnDriver` to return an instance holding that turn's own state.
 *
 * A per-turn object (rather than more adapter methods) is what makes this safe
 * under graph fan-out: one adapter instance drives N concurrent turns, so
 * protocol state must never live on the adapter.
 */
export interface TurnDriver {
  /**
   * Awaited between the child's stdin being wired and the turn's PROMPT being
   * written — the driver's chance to hold a message back until the CLI can
   * actually answer it. Only ever called for the first turn on a process, since
   * whatever it waits for belongs to the process rather than to each prompt.
   *
   * It exists because a CLI can accept a prompt before it is ready to serve
   * one: claude dials its MCP servers at process start and runs a turn without
   * waiting for them, so a prompt sent three seconds in gets a tool surface
   * with the slower servers missing — and a model told once that a tool does
   * not exist keeps believing it. See `ClaudeTurnDriver.awaitPromptReady`.
   *
   * **It must resolve, and it must be bounded by its own deadline.** The turn's
   * silence deadline is the only thing behind it, and settling a turn 30
   * minutes later because a readiness poll hung would cost the user the message
   * this hook exists to protect. It must not reject either — a gate that
   * cannot decide releases; the caller logs and sends the prompt anyway.
   *
   * A cancel during the hold is honoured: the caller drops the prompt rather
   * than writing it into a turn the user has already stopped.
   */
  awaitPromptReady?(io: TurnIo): Promise<void>;
  /**
   * Called once the child's stdin is wired, before any stdout is parsed — the
   * driver's chance to open a conversation the CLI expects the client to start.
   * Runs AFTER the turn's prompt, and so after {@link awaitPromptReady} when a
   * driver defines both.
   */
  onStdinReady?(io: TurnIo): void;
  /** Map one parsed stdout line to zero or more normalized events. */
  onMessage(obj: unknown): AgentEvent[];
  /**
   * Encode one approval verdict as the payload the CLI expects. Undefined =
   * this CLI has no approval protocol and `respondApproval` is a no-op.
   */
  buildApprovalResponse?(
    id: string,
    allow: boolean,
    updatedInput?: unknown,
  ): string | undefined;
  /**
   * Deliver a user message into the turn this driver is running, answering
   * whether the CLI actually got it.
   *
   * The counterpart of `AgentAdapter.buildFollowUpPayload` for a CLI whose
   * delivery is not one stdin LINE but a request in a stateful protocol: the
   * driver holds the session id and the request-id counter, so only it can
   * build the frame, and it must record the frame it sent to understand the
   * reply. That is also why this writes for itself rather than returning a
   * payload — the existing send path already unregisters a frame whose write
   * failed, and a builder that registered one before an unwritten write would
   * leave the turn waiting on a reply that can never come.
   *
   * Undefined = this driver has no such channel, and the adapter's own
   * `buildFollowUpPayload` is used instead (the default of which is "this CLI
   * cannot be told anything more once its prompt is in").
   *
   * **Honest in both directions**, exactly like the payload builder it stands
   * beside: a `true` for a message the agent never received has the chat commit
   * a user row nobody will answer, and a `false` leaves it queued, which is
   * always safe.
   */
  sendFollowUp?(message: FollowUpMessage): boolean;
}

/** Handle to an in-flight turn. */
export interface AgentTurnHandle {
  /**
   * Resolves when the turn finishes by any path (the CLI exits, errors, or is
   * cancelled). Never rejects — terminal outcomes arrive as `error` /
   * `turn_cancelled` events first, so callers await a single settle point.
   */
  readonly done: Promise<void>;
  /** Terminate the underlying CLI process for this turn. */
  cancel(): void;
  /**
   * Answer an `approval_request` event: allow unblocks the tool call (echoing
   * `updatedInput` — the input the request carried); deny rejects it and the
   * agent continues without the tool. Returns whether the verdict was actually
   * delivered — false once the turn has settled/ended (a late verdict must not
   * be recorded as applied) and for adapters whose CLI has no approval
   * protocol.
   */
  respondApproval(id: string, allow: boolean, updatedInput?: unknown): boolean;
  /**
   * Hand the RUNNING turn another user message. Returns whether it was
   * actually delivered — false once the turn has settled, and false for a CLI
   * with no such channel, so a caller can fall back to queueing it for the
   * next turn without asking the adapter what kind it is.
   *
   * Probe-verified on claude 2.1.222: a second `{"type":"user"}` line written
   * to a still-open stream-json stdin is picked up at the next tool boundary
   * of the turn already in flight — a message sent 8s into a 20s command was
   * answered at 29s, in the same process and under the same `result` line.
   * That is what the CLI itself does with a follow-up typed mid-turn, and it
   * is why "queued" here means seconds rather than "after everything finishes".
   *
   * ACP has no equivalent: `session/prompt` is one request per turn, and the
   * protocol gives a client no way to add to a prompt already accepted. Its
   * adapter therefore answers false and the caller keeps the message queued.
   */
  sendUserMessage(message: FollowUpMessage): boolean;
  /**
   * Re-mode the tool-approval posture of the turn ALREADY RUNNING, returning
   * whether the CLI was actually told.
   *
   * Honest in both directions, like {@link AgentTurnHandle.sendUserMessage} —
   * and here the cost of a dishonest true is higher than a dropped message.
   * This is the permission surface: ACKing a change the running turn will not
   * honour tells the user a safety posture they do not have, which is exactly
   * what the caller's refusal exists to prevent.
   *
   * False is the honest answer for a turn with no way to be told, and that is
   * not hypothetical: a claude turn spawned under
   * `--dangerously-skip-permissions` has no permission prompt tool wired at
   * all, so no message could reintroduce a gate it was started without.
   */
  setApprovalMode(mode: AgentApprovalMode): boolean;
}

/** One question a CLI asked the user, projected out of its own tool payload. */
export interface AdapterQuestion {
  /** The question text, ready for a caller envelope or a renderer card. */
  text: string;
  /** Every option label offered, flat across questions; [] when free-text only. */
  options: string[];
}

/** What the mirror is being opened ON — one run's one thread. */
export interface HandoffInput {
  /** The session to open, or null when the thread has produced none yet. */
  sessionId: string | null;
  /** The model the run is chatting as, or null for the CLI's own default. */
  model: string | null;
  /**
   * The agent config directory the run's turns use, or null/omitted for the
   * CLI's default profile.
   *
   * Optional because most askers have none to give: the capability probe asks
   * only whether this CLI can resume AT ALL, and a run that never chose a
   * profile has nothing to pass.
   */
  configDir?: string | null;
}

/**
 * How the user is handed THIS conversation, so they can carry it on themselves.
 *
 * A `command` is a shell invocation that opens the conversation in the CLI's
 * own TUI. The union has one arm today because that is what any CLI here can
 * actually do; the shape exists so a second delivery — a deeplink or a web
 * session URL, once an agent offers one — is a new arm rather than a new
 * subsystem. Nothing outside the adapter layer branches on which it is.
 *
 * A refusal is DATA, not an exception: the adapter layer knows nothing about
 * HTTP, and the owning module decides how to say it.
 */
/**
 * Which conversation is being moved to which profile, for
 * {@link AgentAdapter.carrySessionToConfigDir}.
 *
 * The FOLDER is deliberately absent. A CLI that stores conversations per
 * working directory already records which one this session belongs to, and
 * asking the caller would let the two disagree — claude's own doc block says
 * the directory name it uses is lossy and must never be re-derived, so the
 * only safe answer is the one the store itself gives.
 */
export interface CarrySessionInput {
  /** The conversation, in the CLI's own id namespace. */
  readonly sessionId: string;
  /** The profile that holds it now — null for the CLI's own default. */
  readonly from: string | null;
  /** The profile it should also be readable from — null for the default. */
  readonly to: string | null;
}

/**
 * Whether the conversation followed the run to its new profile.
 *
 * A refusal is DATA on the same rule {@link HandoffResult} follows, and here it
 * is not even a failure: the switch is legitimate either way, and `reason` is
 * the sentence the transcript prints so the user knows the agent is starting
 * fresh rather than silently forgetting the thread.
 */
export type CarrySessionResult =
  { carried: true } | { carried: false; reason: string };

/**
 * A config directory the FOLDER pins, overriding the one geniro hands the CLI.
 *
 * geniro passes the run's profile as an environment variable, and an env var is
 * not the last word: a CLI that reads per-project settings can carry its own
 * `env` block, apply it to ITSELF, and run under a different account than the
 * one the chat says it is on. That is not hypothetical — measured 2026-08-27 on
 * claude 2.1.247, a folder whose `.claude/settings.local.json` sets
 * `env.CLAUDE_CONFIG_DIR` makes the CLI answer `get_usage` for the PINNED
 * profile's account while `CLAUDE_CONFIG_DIR` in its own environment still
 * names the one geniro chose.
 *
 * REPORTED as "I'm running my claude session in different config directory with
 * different account - but now its showing my limits for another account". The
 * limits were right and the PROFILE was wrong, which is the reading this type
 * exists to let the app state: the panel reports whichever account the CLI is
 * actually on, so the two must be able to disagree out loud rather than one of
 * them quietly winning.
 *
 * A null from {@link AgentAdapter.readConfigDirPin} means "nothing pins this
 * folder" — never "this CLI has no such mechanism", which the base's own
 * default already answers by returning null for every folder.
 */
export interface ConfigDirPin {
  /**
   * The directory the CLI will actually use, as the settings file spells it.
   *
   * NOT canonicalized: it is quoted back to the user beside the path they
   * picked, and resolving it would make the two look different for reasons
   * that have nothing to do with the override.
   */
  readonly effective: string;
  /** The file that pinned it — a path the user can open and edit. */
  readonly source: string;
}

export type HandoffResult =
  | {
      ok: true;
      kind: 'command';
      command: string;
      args: string[];
      /**
       * Environment the invocation needs, when a fact about the run cannot be
       * expressed in argv. Empty for most handoffs.
       *
       * It exists because the run's config directory — which ACCOUNT the
       * conversation belongs to — travels only as env (`CLAUDE_CONFIG_DIR`).
       * Dropping it would hand the user a `--resume` against their DEFAULT
       * profile, where that session id does not exist, and the CLI would open
       * an unrelated conversation rather than say so.
       */
      env: Record<string, string>;
    }
  | { ok: false; reason: 'unsupported' | 'no-session' };

/**
 * Everything about ONE CLI that is STATIC — true of the binary before any turn
 * runs, and knowable without asking it anything.
 *
 * One object per adapter, declared in that adapter's `<name>.const.ts` and
 * returned by `AgentAdapter.getConfig()`, so every question whose only per-CLI input
 * is a VALUE is answered once, concretely, on the base class. A field here is
 * the reason a `listEfforts` / `listSkills` / `resolveApprovalMode` override no
 * longer exists on either adapter.
 *
 * What deliberately does NOT belong here:
 * - anything env-dependent (`command` is derived from `kind` through
 *   `resolveAgentBinary`, so a Settings cliPaths override still takes effect
 *   per access);
 * - anything the INSTALLED binary has to be asked (its model list, its reported
 *   commands, whether it streams partials) — config carries only how to ask and
 *   what to fall back to;
 * - anything with per-turn branching (argv assembly, stdin payload, child env)
 *   — those stay `buildArgs` / `buildStdinPayload` / `buildEnv`.
 */
export interface AdapterConfig {
  // ── Identity ────────────────────────────────────────────────────────────
  /**
   * The agent this adapter drives. Also the key `resolveAgentBinary` looks up,
   * so the binary name is never spelled a second time.
   */
  readonly kind: AgentKind;

  // ── Asking the user ─────────────────────────────────────────────────────
  /**
   * The tool this CLI uses to ask the USER a question, or null when it has no
   * question channel at all. The ONE discriminator between a genuine question
   * and a permission check — no service, executor or util may spell a tool name
   * itself.
   */
  readonly questionToolName: string | null;
  /**
   * Whether keeping this CLI's question channel open forces an unattended turn
   * onto the ask posture.
   *
   * True for claude, where it is load-bearing: `--dangerously-skip-permissions`
   * leaves the turn no permission-prompt channel and the AskUserQuestion tool
   * is not wired without one (probe-verified on 2.1.227 across every mode), so
   * a question-capable `auto` node has to spawn on the stdio dialogue with the
   * DAEMON standing in for the bypass. False for a CLI whose questions arrive
   * out-of-band — an ACP vendor request reaches the client whatever session
   * mode the agent is in — where forcing `ask` would park every ordinary
   * permission on a human verdict in a graph nobody is watching.
   *
   * Meaningless when `questionToolName` is null; declare it false there.
   */
  readonly questionsCostAskPosture: boolean;

  // ── Background sub-agents ───────────────────────────────────────────────
  /**
   * Whether this CLI reports the background sub-agents it runs, so the
   * renderer can enclose their work instead of spilling it into the
   * conversation.
   *
   * The mechanism is already CLI-agnostic — an adapter reports one by setting
   * {@link AgentEventOrigin.parentToolUseId} to the id of the tool call that
   * started the delegate — so this field says only whether a given CLI HAS
   * such a signal. Everything downstream (the transcript's sub-agent block,
   * the agents panel's sub-agent rows, the run badge that reads `running`
   * while one is out) keys on that id and never on which CLI produced it.
   *
   * A CLI that does not report one declares WHY, and the reason is a
   * MEASUREMENT with its date and its bounds — not a permanent property. See
   * `.claude/rules/agent-adapters.md`: write down what was checked, so the
   * next reader knows what to re-check rather than trusting the absence.
   * `cursor-acp` is the standing example of why that matters: it declared
   * `reports: false` on the strength of geniro's OWN ACP types carrying no
   * parent id — which measured this codebase, not the wire — and a probe of the
   * real CLI then found the signal (`cursor/task`) it had been discarding.
   *
   * Read by {@link stepsUnavailableReason}'s consumers and by
   * `GET /v1/capabilities` → `subagents[]`, so a chat on a CLI that reports
   * nothing can say so rather than showing an empty list.
   */
  readonly subagents: {
    /** This CLI reports its delegates on the stream. */
    readonly reports: boolean;
    /**
     * Why it does not, when it does not — the CLI's own sentence, naming what
     * was checked. Null when {@link reports} is true.
     */
    readonly unavailableReason: string | null;
    /**
     * Why a reported delegate's own CONVERSATION is not shown, when the CLI
     * announces the delegation but streams nothing the delegate did. Null when
     * its steps ride the same stream as the main thread's (claude), which is
     * what lets the block open into a real thread.
     *
     * A second, sharper fact than {@link reports} rather than a shade of it:
     * "geniro never saw a delegate" and "geniro saw the delegate and this CLI
     * does not stream its work" are different answers, and collapsing them left
     * a cursor delegate's card reading "this sub-agent has not done anything
     * yet" about one that had done thirteen seconds of it.
     *
     * Travels on the delegate's own row (the `subagent_info` item) rather than
     * through a capability lookup, so the row that declares a delegate also
     * carries the reason its thread is empty — one fetch, and the two can never
     * describe different CLIs.
     */
    readonly stepsUnavailableReason: string | null;
  };

  // ── Approval policy ─────────────────────────────────────────────────────
  readonly approval: {
    /**
     * Every mode this CLI honours as a user-visible choice. A mode outside this
     * list is refused where the choice is MADE (chat create/patch).
     */
    readonly modes: readonly AgentApprovalMode[];
    /**
     * The subset of `modes` whose support cannot be known from the CLI's name
     * alone and must be PROVED against the installed binary. It decides whether
     * a run pays for a probe turn at all; `[]` means every claimed mode is real.
     */
    readonly probedModes: readonly AgentApprovalMode[];
    /**
     * What a mode degrades to once a probe PROVED the installed binary rejects
     * it, plus the line the transcript owes the user.
     *
     * A probed mode deliberately ABSENT from this table rides through and is
     * rejected loudly by the CLI. That absence is policy, not an oversight —
     * see claude's `plan`, where degrading a no-execute mode into an executing
     * one would invert the intent the user selected it for.
     */
    readonly degradeOnProbeFail: Readonly<
      Partial<
        Record<
          AgentApprovalMode,
          { readonly to: AgentApprovalMode; readonly reason: string }
        >
      >
    >;
    /**
     * The line owed to the user when a CLI with exactly ONE honoured mode is
     * asked for a different one — evaluated only when `modes.length === 1`, and
     * checked BEFORE `degradeOnProbeFail` (a single-mode CLI has nothing to
     * probe). Null when `modes` has more than one entry.
     */
    readonly soleModeDegradeReason:
      ((requested: AgentApprovalMode) => string) | null;
  };

  // ── Reasoning effort ────────────────────────────────────────────────────
  /**
   * The `--effort` vocabulary this CLI accepts, weakest first, or `[]` when it
   * has no such control at all. WRITTEN DOWN, never scraped from `--help`: a
   * CLI can accept a level its own help omits.
   */
  readonly efforts: readonly AgentEffort[];
  /**
   * Why this CLI offers no effort PICKER, or `null` when {@link efforts} has
   * entries. MUST agree with it — `[]` here with a null reason would render an
   * inert chip with nothing to explain it, which is the state this replaces
   * (pinned in `agent-adapter.spec.ts`).
   *
   * A SENTENCE, like the reasons on `usage` / `subagents` / `followUp`, because
   * the renderer shows it: an effort readout the user cannot change reads as
   * broken unless it names what DOES change it. "cursor cannot" is not enough —
   * the answer that helps is where the value actually lives.
   */
  readonly effortsUnavailableReason: string | null;
  /**
   * Whether {@link efforts} is the WHOLE vocabulary, or only the part of it a
   * static list can hold.
   *
   * It decides one thing: whether the daemon refuses an unknown level UP FRONT,
   * at run creation, or lets the turn report what the agent said about it.
   *
   * True for a CLI whose levels belong to the BINARY — claude's `--effort` takes
   * the same words whichever model runs, so a word outside the list is one the
   * CLI will silently ignore, and refusing it is the only way the user learns.
   *
   * False for a CLI whose levels belong to the MODEL, where the list is a UNION
   * of the ones seen and cannot be complete: cursor's `gpt-5.2` offers
   * `extra-high`, which no other model has, so an exhaustive check refused a
   * level the CLI genuinely accepts and the run could not be created at all.
   * Such a CLI is not left unguarded — its driver checks the value against the
   * model's own options and says on the transcript when one does not apply,
   * which is both more accurate and available per turn rather than per app
   * release.
   */
  readonly effortsAreExhaustive: boolean;

  // ── Context window ──────────────────────────────────────────────────────
  /**
   * Why this CLI offers no context-window PICKER, or `null` when it does and
   * {@link AgentAdapter.listModelContextWindows} answers for real.
   *
   * There is no static superset beside it, unlike {@link efforts}, and that
   * asymmetry is deliberate: a window size is meaningless without the model it
   * belongs to (`1m` on a model that has no such axis is not a weaker version
   * of anything), so there is nothing a CLI-wide union could usefully stand in
   * for. A CLI answers per model or it declares this sentence and offers
   * nothing.
   */
  readonly contextWindowsUnavailableReason: string | null;

  // ── Models ──────────────────────────────────────────────────────────────
  /**
   * The documented alias / fallback set — the FLOOR of `listModels`, never the
   * whole of it, and what a CLI that cannot be asked answers with so the picker
   * is never empty. How the live list is obtained stays `listModels`, which is
   * the one member config cannot express (a home-file read vs a subcommand).
   */
  readonly builtinModels: readonly AgentModel[];

  // ── Skills / commands on disk ───────────────────────────────────────────
  /**
   * Where this CLI keeps what it can be invoked with, as path SEGMENTS joined
   * under each root (the project cwd first, then the user's home dir). Within
   * one root, `skills` are scanned before `commands` — the two arrays' order IS
   * the shadowing order the CLI itself applies, which the caller's
   * first-occurrence-wins de-dup relies on.
   */
  readonly skillRoots: {
    /**
     * The segments a CONFIG DIRECTORY stands in for, under a home root — so
     * `['.claude']` for a CLI whose home configuration lives at
     * `~/.claude` and whose `CLAUDE_CONFIG_DIR` replaces exactly that.
     *
     * It exists so the roots below are declared ONCE: a profile's own copy of
     * each is the same list with this prefix removed. `null` for a CLI whose
     * account is not decided by a directory (cursor says so in
     * `configDir.unavailableReason`), which then keeps the home root whatever
     * a run asks for.
     */
    readonly profileAnchor: readonly string[] | null;
    /** `<root>/<…>/<name>/SKILL.md` dirs; `[]` when the CLI has no skills convention. */
    readonly skills: readonly (readonly string[])[];
    /** `<root>/<…>/**.md` command files; `[]` when the CLI has no commands convention. */
    readonly commands: readonly (readonly string[])[];
    /**
     * The plugin HOSTS whose installed plugins this CLI also loads skills from,
     * discovered rather than enumerated: a cache root under the user's home
     * whose `<marketplace>/<plugin>/<version>` layout is walked at read time, so
     * no plugin name, marketplace or version is ever written down here and a
     * plugin installed after this shipped is found without a release.
     *
     * `[]` when the CLI has no plugin mechanism, or — the case worth stating —
     * when it already REPORTS its plugins' commands itself
     * (`listReportedCommands`), where scanning would file a second row per
     * skill under whatever name the files use rather than the name the CLI
     * answers to.
     */
    readonly plugins: readonly {
      /** Segments of the cache root, under the user's home dir. */
      readonly cacheDir: readonly string[];
      /**
       * The manifest paths (relative to a version dir) that mark it as a
       * plugin — this CLI's own list, in its own precedence order. Without it
       * the walk would return every three-deep directory under the root.
       */
      readonly manifests: readonly (readonly string[])[];
      /**
       * Where INSIDE a plugin this CLI's skills live, best build first. The
       * FIRST entry that yields any skill wins for that plugin: a plugin
       * shipping a build for this CLI beside a generic one must contribute the
       * former alone, or the same skill is offered twice under two spellings
       * and only one of them can actually be run.
       */
      readonly skillDirs: readonly (readonly string[])[];
    }[];
  };

  // ── Live (token-level) streaming ────────────────────────────────────────
  /**
   * How to establish whether the INSTALLED binary can stream partial assistant
   * text. Null when the CLI has no such mode at all, which answers
   * `supportsLiveStream` false without spawning anything.
   */
  readonly liveStream: {
    /** Utility argv whose stdout is searched — `--help` is the cheapest honest source. */
    readonly probeArgs: readonly string[];
    /**
     * ONE string, used twice by design: pushed onto argv when a turn asks for
     * partials, and searched for in `probeArgs`' stdout. The same binary that
     * would reject it on argv is the one that advertises it, so a single field
     * makes the two reads incapable of drifting apart.
     */
    readonly flag: string;
  } | null;

  // ── Commands the CLI reports about ITSELF ───────────────────────────────
  /**
   * How to harvest the built-ins and plugin commands that exist nowhere on disk
   * to be scanned: start one turn in a throwaway cwd and cancel it the instant
   * the normalized `slash_commands` event lands. Null when the CLI makes no such
   * report, which answers `listReportedCommands` with `[]` and never spawns.
   */
  readonly reportedCommands: {
    /** Never reached by the model — the turn is cancelled the moment init lands. */
    readonly probePrompt: string;
    /** A hung probe must not wedge the caller forever. */
    readonly probeTimeoutMs: number;
    /** Defensive bound on the reported list. */
    readonly maxCommands: number;
    /** Names starting with this are the CLI's INTERNALS, not things a user invokes. */
    readonly internalPrefix: string | null;
  } | null;

  // ── Commands geniro provides for this CLI ───────────────────────────────
  /**
   * The slash commands this application adds to that CLI, which exist nowhere
   * outside it — see {@link AgentGeniroCommand}. Empty for a CLI that needs
   * nothing added.
   */
  readonly geniroCommands: readonly AgentGeniroCommand[];

  // ── Agent-to-agent calls (MCP) ──────────────────────────────────────────
  readonly mcp: {
    /**
     * Whether the call tools are withheld until a machine-level trust probe has
     * PASSED. True is the cautious answer: the shut-out caller degrades VISIBLY.
     */
    readonly callToolsRequireTrustProbe: boolean;
    /**
     * Whether an MCP endpoint reaches this CLI ONLY through a config file in the
     * run's own cwd, merged before the spawn and restored after. False means the
     * endpoint rides the turn itself, so nothing outside it ever sees the token.
     */
    readonly endpointRequiresCwdConfig: boolean;
    /**
     * Why this CLI's loaded MCP servers cannot be listed, or null when they
     * can be.
     *
     * A VALUE rather than a method because nothing acts on it — it is carried
     * to the UI and shown. It exists so that "this folder has no servers" and
     * "this CLI cannot tell us" stay different answers: both are an empty list,
     * and a reader that cannot distinguish them either invents a reason or
     * branches on which CLI it is holding. This field is what lets the panel
     * say something true without ever asking that question.
     */
    readonly listingUnavailableReason: string | null;
    /**
     * Why NO server of this CLI can be switched off, or null when some can.
     *
     * SEPARATE from {@link listingUnavailableReason} on purpose: listing and
     * toggling are different capabilities that merely coincide today. Reading
     * one to answer the other would tell the first CLI that can list but not
     * toggle (or the reverse) a reason that does not answer the question.
     */
    readonly toggleUnavailableReason: string | null;
    /**
     * What this CLI loads in its OWN interactive session that a headless turn
     * never gets — the sentence the panel shows under the rows — or null when
     * there is no such difference.
     *
     * This exists because a LISTING cannot say it. The panel is complete for
     * the turns geniro actually runs, and the user compares it against their
     * terminal's `/mcp`, which shows more; with nothing said, the only
     * available conclusion is that geniro lost some rows. Stating the gap is
     * the whole fix — the missing servers must NOT be listed, because they are
     * genuinely not loaded and a row for one would promise tools the agent
     * does not have.
     */
    readonly interactiveOnlyNote: string | null;
    /**
     * Why a row the user turned down in their OWN config carries no switch.
     *
     * The one remaining reason a switchable CLI still shows a locked row: the
     * toggle writes the CLI's own per-folder list, which reaches every scope,
     * but it cannot undo a rejection whose every source copy the CLI unions.
     */
    readonly userDisabledReason: string;
    /**
     * Argv that signs this CLI in to ONE MCP server, with the server's name
     * appended — `['mcp', 'login']` for both CLIs today. Null when the CLI has
     * no such command, and then {@link loginUnavailableReason} says so.
     *
     * A VALUE, not a method: what differs per CLI is the words, not the
     * mechanism, so `AgentAdapter.runMcpLogin` is concrete over this.
     *
     * The daemon RUNS this — which is a REVERSAL of what this block said for
     * two milestones, on a measurement that was right about the fact and wrong
     * about the conclusion. The terminal handoff it reversed was kept a while
     * as the fallback and is now GONE, unused by any caller once every sign-in
     * moved in-app.
     *
     * What was measured (claude 2.1.223, re-confirmed on 2.1.232): with stdin a
     * pipe, `claude mcp login <name>` answers "stdin isn't a terminal, so
     * authentication can't be completed here" and exits BEFORE printing
     * anything — an upfront refusal, so no amount of waiting or piping helps.
     * True, and the conclusion drawn from it ("so it must go to the user's own
     * terminal") skipped the middle option: the CLI wants a TERMINAL, not a
     * human. Under a pty the same command prints its authorization URL, opens
     * the browser itself and serves its own `http://localhost:<port>/callback`
     * — measured 2026-08-17. The window a user was made to look at was never
     * the mechanism.
     *
     * The pty costs no native module ({@link AgentCommandOptions.pty} carries
     * the how and why), which is what the old note assumed it would.
     */
    readonly loginArgs: readonly string[] | null;
    /**
     * Substrings of this CLI's own output that mean a server sign-in did NOT
     * complete — matched case-insensitively.
     *
     * A daemon-run sign-in under a pty cannot read an exit STATUS: the status
     * belongs to the `script` wrapper, not to the CLI beneath it. What the CLI
     * says is the only verdict there is. Empty for a CLI whose sign-in the
     * daemon does not run.
     *
     * Note what this is NOT used for: whether the server is now authenticated.
     * That is re-read from the listing, exactly as the account login's status
     * is re-probed rather than inferred from an exit — this only decides which
     * sentence the panel shows about the attempt.
     */
    readonly loginFailureMarkers: readonly string[];
    /**
     * Why no server of this CLI can be signed in to, or null when they can.
     *
     * Separate from {@link toggleUnavailableReason} for the same reason that one
     * is separate from {@link listingUnavailableReason}: signing in and
     * switching off are different capabilities, and a CLI that gains one
     * without the other must not be handed a sentence answering the other
     * question.
     */
    readonly loginUnavailableReason: string | null;
    /**
     * Why an UNAPPROVED server of this CLI cannot be approved from here, or
     * null when it can.
     *
     * Separate from {@link toggleUnavailableReason} even though cursor answers
     * both with the same subcommand, because the two capabilities come apart on
     * the CLI that has one and not the other: claude's toggle writes
     * `disabledMcpServers` and reaches every scope, and approves nothing — its
     * `Pending approval` rows are cleared in the CLI's own `/mcp` screen, which
     * a headless turn cannot open. Reading the toggle to answer this would put
     * an Approve button on claude's rows with nothing behind it, which is the
     * silent no-op the whole block exists to prevent.
     *
     * There is no `approveArgs` beside it: approving IS enabling for the CLI
     * that can do it (`cursor-agent mcp enable <name>` answers "✓ Enabled and
     * approved MCP server", measured on 2026.08.11-e8db854 against a project
     * whose `.cursor/mcp.json` server listed as `not loaded (needs approval)`),
     * so `AgentMcpService.setEnabled` is already the whole mechanism and a
     * second argv would be a second way to spell one command.
     */
    readonly approveUnavailableReason: string | null;
  };

  // ── Signing the CLI itself in ───────────────────────────────────────────
  /**
   * How the user signs in to the CLI, as opposed to {@link AdapterConfig.mcp}'s
   * `loginArgs`, which signs in to one MCP server the CLI loads.
   *
   * A separate block because the two fail independently: a CLI whose account
   * session expired still lists its MCP servers' auth state fine, and the
   * message the user needs is about the CLI, not about a server.
   */
  readonly auth: {
    /**
     * Argv that starts this CLI's own interactive sign-in — `['auth', 'login']`
     * for claude 2.1.227, `['login']` for cursor-agent 2026.08.04-aaa8809, both
     * read from the binaries' own `--help`. Null when the CLI has no such
     * command, and then {@link loginUnavailableReason} says so.
     *
     * A VALUE, not a method: what differs per CLI is the words, not the
     * mechanism, so `AgentAdapter.runLogin` is concrete over this.
     *
     * The daemon RUNS this. It resolved it for a terminal to run for two
     * milestones, on the reasoning the MCP sibling above records at length —
     * an interactive browser flow wants a TTY — and the account login turned
     * out not to want even that: re-probed on claude 2.1.228 and cursor-agent
     * 2026.08.11, neither refuses a closed stdin. Both print a usable URL and
     * open the browser themselves, claude then accepting a pasted code and
     * cursor polling to completion. The resolve-only path is gone with its
     * last caller.
     */
    readonly loginArgs: readonly string[] | null;
    /** Why this CLI cannot be signed in to from here, or null when it can. */
    readonly loginUnavailableReason: string | null;
    /**
     * Argv that signs this CLI OUT — `['auth', 'logout']` for claude 2.1.227,
     * `['logout']` for cursor-agent, both read from the binaries' own `--help`.
     * Null when the CLI has no such command, and then
     * {@link logoutUnavailableReason} says so.
     *
     * It exists so a card can offer the action that MATCHES the state it is
     * reporting. Before it, the only account action was Sign in, offered to
     * every detected CLI including ones the probe had just confirmed signed in —
     * which reads as an unfinished setup step rather than as an option, and was
     * reported as exactly that.
     *
     * Resolved and never run, like every other invocation in this block: a
     * sign-out is quick and non-interactive, but it is still the user's account
     * and belongs in a terminal they can see, beside the sign-in that undoes it.
     */
    readonly logoutArgs: readonly string[] | null;
    /** Why this CLI cannot be signed out from here, or null when it can. */
    readonly logoutUnavailableReason: string | null;
    /**
     * Output substrings that mean "this CLI is now waiting for a code pasted on
     * stdin" during a sign-in the DAEMON is running.
     *
     * The reason it exists: `loginArgs` can be run headlessly — the two CLIs
     * print a URL and open the browser themselves — but they then finish in two
     * different ways, and a caller cannot tell them apart without asking. cursor
     * POLLS to completion and needs nothing ("Waiting for browser
     * authentication…", probed 2026-08-12 on 2026.08.11-e8db854 with stdin
     * closed, so its list is empty). claude prints `Paste code here if prompted
     * >`, and its browser round-trip may or may not complete over the localhost
     * listener it also opens — so its marker is what turns a hung child into a
     * field the user can paste into.
     *
     * EVIDENCE-GATED like {@link expiredMarkers}, and empty is a real answer: an
     * invented marker either never fires or fires on unrelated output and asks
     * the user for a code no CLI wants.
     *
     * NOTE the deliberate narrowing this contradicts nothing in: `mcp login`
     * genuinely REFUSES a non-TTY stdin (probe-verified, claude 2.1.223), and
     * that measurement was generalised to the ACCOUNT login without re-checking.
     * Re-probed on 2.1.228: `claude auth login` with stdin closed does not
     * refuse — it prints a usable URL and waits. The two commands differ.
     */
    readonly loginCodePromptMarkers: readonly string[];
    /**
     * Substrings that mark a failed turn as "your account session is no longer
     * valid" — matched case-insensitively against the turn's error message, and
     * the reason an error row can offer Sign in instead of only a stack trace.
     *
     * EVIDENCE-GATED, and empty is a legitimate answer: a marker invented from
     * wording nobody observed either matches nothing (a dead feature) or
     * matches too much, and offering sign-in for an unrelated failure sends the
     * user to a command that cannot fix what they hit. A CLI whose auth-failure
     * wording has not been seen declares `[]` and says so — the sign-in stays
     * reachable from the agents panel, which needs no failure to be pressed.
     */
    readonly expiredMarkers: readonly string[];
    /**
     * Env var names this CLI is entitled to inherit from the daemon's own
     * environment — the credentials `utils/child-env.ts` strips from EVERY child
     * so they cannot cross agents, re-injected for this one alone.
     *
     * A FIELD rather than a hook, and the reason is the bug it replaced: the
     * entitlement used to live in `buildEnv`, which only the turn path calls, so
     * a CLI's turns ran authenticated while its `runCommand` listings ran signed
     * out — cursor's model picker collapsed to one row and its MCP panel
     * reported nothing, both reading as facts about the user's setup rather than
     * as a failure to ask. Two call paths were free to disagree about the same
     * entitlement. One list read once on the base makes that unrepresentable.
     *
     * Empty is a real answer: a CLI whose credentials live on disk needs nothing
     * here. Like {@link expiredMarkers} that is a MEASUREMENT, not an
     * assumption — say what was checked, because "needs no env" and "we never
     * tried without it" look identical from the outside.
     */
    readonly inheritedEnvKeys: readonly string[];
  };

  // ── Taking over a conversation the CLI already holds ────────────────────
  /**
   * What this CLI can offer of the conversations already on the user's machine
   * — the facts behind {@link AgentAdapter.listSessions},
   * {@link AgentAdapter.prepareSessionImport} and
   * {@link AgentAdapter.readSessionHistory}.
   */
  readonly sessions: {
    /**
     * Why the conversations this CLI holds cannot be listed, or null when they
     * can be. Carried to the picker and shown there, so an empty list explains
     * itself instead of reading as "you have no history".
     */
    readonly listingUnavailableReason: string | null;
    /**
     * What the listing DOES NOT reach, or null when it reaches everything.
     *
     * Separate from {@link listingUnavailableReason} because it is the shape
     * that would otherwise be invisible: cursor lists its ACP sessions in full
     * and holds a second store — its interactive `cursor-agent` chats — that
     * the same server answers `Session not found` for (probed 2026-08-16 on
     * 2026.08.11-e8db854, an id out of `~/.cursor/chats/` under its own
     * recorded cwd). A user whose terminal history is all in that store sees a
     * short, correct list and concludes the feature is broken; this is the
     * sentence that tells them which half they are looking at.
     */
    readonly listingPartialReason: string | null;
    /**
     * Why a resumed thread starts with an empty transcript, or null when its
     * history arrives one way or the other.
     *
     * Non-null is the honest answer for a CLI that can hand back the
     * conversation but not the record of it — the thread continues correctly
     * (the AGENT still has its context) while geniro can show nothing before
     * the user's next message, which without a sentence reads as an import that
     * silently did nothing.
     */
    readonly historyUnavailableReason: string | null;
    /**
     * Why a search of these conversations reaches only their titles and
     * folders, or null when it reaches what was SAID in them.
     *
     * A picker's search is only as good as the text behind it, and a title here
     * is one line — for claude, the conversation's opening prompt. Somebody
     * looking for the thread where a bug was diagnosed remembers the diagnosis,
     * not how they opened the conversation, so a title-only search finds
     * nothing and reads as a broken feature rather than as a narrow one. What
     * makes the difference is whether the transcript is READABLE: claude keeps
     * one JSONL per session in its own profile, while cursor's lives inside an
     * ACP server whose `session/list` has no search parameter at all.
     */
    readonly contentSearchUnavailableReason: string | null;
  };

  // ── Config directory (which profile / account the CLI runs as) ──────────
  /**
   * Whether this CLI can be pointed at a different config directory for one
   * invocation — the directory holding its credentials, settings and plugins,
   * and therefore which ACCOUNT the turn runs under.
   */
  readonly configDir: {
    /**
     * The env var that carries it to this CLI (`CLAUDE_CONFIG_DIR`), or null
     * when the CLI has no such mechanism. Named here rather than spelled in
     * `buildEnv` because it is the same kind of per-CLI VALUE as a flag name,
     * and the adapter rules put those in config.
     */
    readonly envVar: string | null;
    /**
     * Why this CLI cannot be given one, or `null` when it can.
     *
     * Non-null is the "this CLI has no such thing" answer, and it is what
     * stops a run's `configDir` being validated, refused, or spawned for an
     * agent that would ignore it — geniro becoming the silent one is exactly
     * the failure the field exists to prevent. MUST agree with `envVar`: a
     * null reason promises a var to carry it.
     */
    readonly unavailableReason: string | null;
    /**
     * Why an OPEN conversation cannot follow the run to another profile, or
     * null when it can.
     *
     * A separate question from `unavailableReason`, and a run can genuinely
     * answer them differently: pointing the NEXT turn at another account is
     * one thing, and taking the conversation so far with it is another. Where
     * this is non-null the switch still happens — the thread's transcript is
     * geniro's own and is untouched — but the agent starts a fresh CLI
     * conversation from that point, which is what the user is told.
     *
     * MUST agree with {@link AgentAdapter.carrySessionToConfigDir}: a null
     * reason promises that method does something.
     */
    readonly sessionCarryUnavailableReason: string | null;
  };

  // ── A message into a turn that is already running ───────────────────────
  /**
   * Whether this CLI can be handed a user message MID-TURN — the fact behind
   * `buildFollowUpPayload`, lifted into config so it can be reported.
   *
   * The method alone could never answer this for the renderer: it is
   * `protected`, per-turn, and only tells you what happened AFTER a message was
   * already written. The composer needs to know BEFORE it offers the control,
   * because the queue's "send now" is exactly this capability and an agent
   * without it must not be offered a button that silently parks the message.
   *
   * MUST agree with `buildFollowUpPayload`: null here promises the override
   * exists. The two are pinned together in `agent-adapter.spec.ts` — a config
   * claiming a channel the adapter never implements would have the composer
   * promise immediate delivery and the daemon answer RUN_BUSY.
   */
  readonly followUp: {
    /**
     * Why this CLI cannot take a message into a running turn, or `null` when it
     * can. A SENTENCE, like the two reasons above, because the renderer shows
     * it on the disabled control — "not available" with no cause is the silent
     * refusal these fields exist to replace.
     */
    readonly unavailableReason: string | null;
    /**
     * Whether delivering that message STOPS what the agent is currently doing.
     *
     * The two shipped CLIs answer this differently and the difference is what
     * the user is about to do, so it cannot be left to a shared sentence.
     * Claude's stream-json stdin is a conversation: the message joins the turn
     * and the agent picks it up at its next tool boundary, having finished what
     * it was on. Cursor's ACP has no such frame, and a second `session/prompt`
     * on a live session CANCELS the first — probe-verified on
     * 2026.08.11-e8db854, where a counting turn twelve seconds in answered
     * `{"stopReason":"cancelled"}` while the injected prompt ran to `end_turn`
     * with the conversation intact.
     *
     * So a press means "add this" on one CLI and "drop what you are doing and
     * answer this" on the other — a tool call in flight is lost on the second.
     * The renderer says which before the press rather than after.
     */
    readonly interrupts: boolean;
  };

  // ── What a turn cost ───────────────────────────────────────────────────────
  /**
   * Whether this CLI reports the tokens and money a turn spent, or the reason
   * its context meter will always be empty.
   *
   * Here rather than inferred from an absent figure, because the two look
   * identical from outside and mean opposite things: a turn that has not
   * finished yet has no usage, and a CLI that never sends any has none either.
   * The renderer cannot tell them apart, and a blank ring answered the user's
   * "why don't I see context here?" with silence.
   */
  readonly usage: {
    /**
     * Why usage never arrives, or `null` when it does. A SENTENCE, for the same
     * reason as the fields above: it is what the meter says when pointed at.
     */
    readonly unavailableReason: string | null;
    /**
     * Whether this CLI can be asked what its window currently HOLDS — the
     * category breakdown behind `AgentSession.readContextUsage` — and if so,
     * WHICH channel the answer comes from.
     *
     * Its own field beside the one above rather than folded into it, because
     * the two are genuinely independent: a CLI can report a turn's token
     * totals perfectly and still have no channel for "what is in the window
     * and what put it there".
     *
     * The channel rides the same field as the reason so the two cannot
     * disagree — and it is here rather than left implicit because the CALLER
     * has to know whether there was anything to ask before it can say why an
     * answer is missing. Inferring that from "either channel exists" told
     * every reaped claude chat that its agent "did not answer in time" when
     * nothing had been asked at all: claude reads from the live process alone,
     * and a claude chat that has ever run keeps a session id forever.
     */
    readonly breakdown: UsageReading;
    /**
     * The same answer for what the ACCOUNT behind this CLI is allowed — the
     * plan's rate-limit windows behind `AgentAdapter.readPlanLimits`.
     *
     * A third independent field for the same reason the second one exists: the
     * three questions are answered by three different mechanisms, and a CLI can
     * have any one of them without the others. Plan limits are not even about
     * the conversation — they are about the subscription the conversation runs
     * on — so a CLI reporting a perfect window breakdown may still have no way
     * to say when the user will be cut off.
     */
    readonly planLimits: UsageReading;
  };

  // ── Handing the conversation to the user ────────────────────────────────
  /**
   * How this CLI reopens one of ITS OWN sessions interactively, so the user can
   * take the conversation over — or the reason it cannot.
   *
   * Probe-verified that the reason arm is not hypothetical: cursor-agent
   * accepts `--resume <id>`, but an ACP session id is not in its chat store, and
   * resuming an unknown id SILENTLY CREATES AN EMPTY CHAT rather than failing.
   * A missing handoff there is not a gap to paper over — offering the button
   * would drop the user into a blank conversation with no error anywhere.
   */
  readonly handoff:
    | {
        readonly kind: 'resume-command';
        /** The flag that resumes a session id — argv is `[resumeFlag, sessionId]`. */
        readonly resumeFlag: string;
        /**
         * The flag naming the model, so a mirror opens on the SAME model the chat
         * is running.
         *
         * Without it the TUI resumes under the CLI's own default, which is a
         * different model with a different window — so the mirror of a 1M-window
         * chat reported a 200k context beside it and read as a different
         * conversation entirely.
         *
         * Required, not nullable: a CLI whose TUI cannot be told a model would
         * declare that by having no `terminal` block worth resuming into at all.
         * A real one re-adds the null arm with its reason, and a test that enters
         * it.
         */
        readonly modelFlag: string;
        /**
         * What a resumable session id looks like for this CLI. A value produced by
         * a DIFFERENT CLI must not be handed to this one's TUI.
         */
        readonly sessionIdPattern: RegExp;
      }
    | {
        readonly kind: 'unavailable';
        /** Stated to the user verbatim, so "no button" is never unexplained. */
        readonly reason: string;
      };
}
