import { spawn as nodeSpawn } from 'node:child_process';

import type {
  AgentApprovalMode,
  AgentEvent,
  AgentTurnHandle,
  FollowUpMessage,
  TurnIo,
} from '../adapters/adapter.types';
import { isUserQuestion } from './approval-answer';
import { buildChildEnv } from './child-env';
import { trackDetachedChild } from './child-journal';
import { createGroupTerminator } from './kill-tree';
import { NdjsonBuffer } from './ndjson-buffer';

/**
 * The slice of a child process this module depends on. Narrower than node's
 * `ChildProcess` so a test can supply a fake without reconstructing the whole
 * interface — the real `spawn` result satisfies it structurally.
 */
export interface SpawnedProcess {
  /** Child PID. Doubles as the process-group id when spawned `detached`. */
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdin: NodeJS.WritableStream | null;
  on(
    event: 'close' | 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: 'error', listener: (err: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => SpawnedProcess;

/**
 * Default: node's `spawn` with all three stdio streams piped, and `detached` so
 * the child becomes its own process-group leader. That lets {@link runCliSession}
 * signal the WHOLE group on cancel/shutdown (`process.kill(-pid, …)`) and reap the
 * tool/MCP grandchildren a coding agent forks — a single-PID kill would orphan them.
 *
 * `detached` is also what makes the group survive the daemon's own death, so the
 * spawn is journaled here — in the same expression that creates it, before any
 * caller can see the child. The next boot reaps whatever the journal still
 * holds; see `child-journal.ts`.
 */
export const defaultSpawn: SpawnFn = (command, args, options) => {
  const child = nodeSpawn(command, args, {
    ...options,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  trackDetachedChild(child, command);
  return child;
};

/**
 * When the child's stdin is closed — the one knob that decides whether a
 * process serves one turn or many.
 *
 * - `payload` — closed immediately after the opening payload, so a CLI reading
 *   its prompt from argv never blocks on stdin.
 * - `turn` — closed on the turn's terminal event, so a stream-json CLI that
 *   held a mid-turn dialogue stops waiting and exits. ONE turn per process.
 * - `session` — never closed automatically; only {@link CliSession.close} ends
 *   it. This is what lets one process serve turn after turn, which is the
 *   whole point: the CLI's own MCP servers (and anything they own, up to a
 *   browser the user is logged into) are booted once per RUN instead of once
 *   per message.
 */
export type StdinLifetime = 'payload' | 'turn' | 'session';

/**
 * The session owner's answer for an approval request that arrives with NO turn
 * in flight: `true` answer it now, `false` refuse it now, `null` hold it for
 * the next turn to adopt.
 *
 * Named because three signatures spell it — the session option, the adapter's
 * `startSession` opts, and the registry's `startTurn` — and a shape restated
 * three times is a shape that drifts.
 *
 * The tool NAME is the whole input, deliberately. It is what tells a question
 * from a permission, and keying on the name rather than on a payload flag is
 * this codebase's standing rule for that decision — a flag can drift between
 * CLI releases and quietly move a tool across the human gate.
 */
export type BetweenTurnApproval = (request: {
  toolName: string;
}) => boolean | null;

/** An `approval_request`, narrowed — the only event kind that is ever held. */
type ApprovalRequestEvent = Extract<AgentEvent, { type: 'approval_request' }>;

/**
 * How many between-turn approval requests one session will hold at once.
 *
 * Not a tuning knob so much as a refusal to grow without bound: a CLI that
 * keeps asking on a chat the user has walked away from would otherwise hold
 * one entry — and one blocked tool call — per request for the session's whole
 * 30-minute life. Twenty is far above any real conversation's between-turn
 * backlog (a turn holding even two is unusual) while still being a number.
 */
const MAX_HELD_APPROVALS = 20;

/** Everything one turn on a {@link CliSession} needs. */
export interface CliTurnOptions {
  /**
   * Written to the child's stdin to open this turn. Undefined = nothing to
   * write (a CLI that takes its prompt from argv, or a protocol whose opening
   * message comes from {@link CliTurnOptions.onStdinReady} instead).
   */
  stdinPayload?: string;
  onEvent: (event: AgentEvent) => void;
  /**
   * Encode one approval verdict as the stdin line the CLI expects (the
   * adapter owns the wire format). Undefined = this CLI has no approval
   * protocol and `respondApproval` is a no-op.
   */
  buildApprovalResponse?: (
    id: string,
    allow: boolean,
    updatedInput?: unknown,
  ) => string | undefined;
  /**
   * Encode a user message sent while THIS turn is still running, as the stdin
   * line the CLI expects. Undefined = this CLI cannot be told anything more
   * once its prompt is in, and `sendUserMessage` is a no-op.
   */
  buildFollowUpPayload?: (message: FollowUpMessage) => string | undefined;
  /**
   * Encode a mid-turn approval-mode change as the stdin line the CLI expects.
   * Undefined = THIS turn cannot be re-moded, and `setApprovalMode` is a no-op
   * — which is a per-TURN fact, not a per-CLI one: the same adapter answers
   * differently for a turn it spawned with a permission dialogue and one it
   * spawned without.
   */
  buildApprovalModePayload?: (mode: AgentApprovalMode) => string | undefined;
  /**
   * Encode an in-protocol "stop what you are doing" as the stdin line the CLI
   * expects. Undefined = this turn can only be stopped by killing it.
   *
   * Only consulted for a `session` stdin lifetime, and that restriction is the
   * point rather than an optimization: on a one-turn process killing the group
   * costs nothing extra, while on a run-scoped one it would tear down exactly
   * the MCP servers the session exists to keep alive. Probe-verified on claude
   * 2.1.223 — a `control_request`/`interrupt` was answered in 2ms and ended the
   * turn with the process still running.
   */
  buildInterruptPayload?: () => string | undefined;
  /**
   * Called once this turn's opening payload (if any) has been written — before
   * the handle is returned, so a client-initiated protocol can send its first
   * message ahead of any stdout.
   */
  onStdinReady?: (io: TurnIo) => void;
}

export interface CliSessionOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Extra env merged over `process.env` for the child. */
  env?: Record<string, string>;
  stdinLifetime: StdinLifetime;
  /** Maps each parsed stream-json object to zero or more normalized events. */
  mapper: (obj: unknown) => AgentEvent[];
  spawn?: SpawnFn;
  logger?: SessionLogger;
  /**
   * The tool name this CLI asks the USER an open-ended question with, or null
   * when it has none. Supplied by the adapter from its own config — this module
   * never learns any CLI's names.
   *
   * It exists so the between-turns refusal can tell a permission check from a
   * question. Refusing a permission check is honest: no turn can carry the
   * verdict. Refusing a QUESTION answers it "no" on the user's behalf, in their
   * name, and they never see it was asked.
   */
  questionToolName?: string | null;
  /**
   * What to do with an approval request that arrives with NO turn in flight —
   * see {@link BetweenTurnApproval} for the tri-state.
   *
   * Supplied by the session's OWNER, because the answer depends on the run's
   * approval posture and nothing at this layer knows it. Without it this module
   * had to decide alone, and both of its answers were wrong in the same way —
   * a plain permission was refused under `auto`, where the whole contract is to
   * approve it, and the refusal reached the user as "Denied by the user in
   * Geniro" for a card they were never shown.
   *
   * Undefined keeps the previous behaviour for callers that have no posture to
   * offer: refuse a permission, hold a question.
   */
  betweenTurnApproval?: BetweenTurnApproval;
  /**
   * A NON-approval event that arrived with no turn in flight, handed to the
   * session's owner instead of being dropped.
   *
   * The owner gets it because only it knows what the event belongs to: the
   * events are turn-less but not run-less, and a run's transcript is exactly
   * the durable place they still have. Kept as a hand-off rather than a
   * replay — this module must never give one turn's output to another turn,
   * which is why these are not buffered like {@link BetweenTurnApproval}'s
   * held requests.
   *
   * WHICH of them are worth keeping is the owner's call too, and the caution
   * is real: a `tool_result` pairs with a call already on the transcript by
   * id, so it lands unambiguously, while a stray message has no such anchor.
   *
   * Undefined = the previous behaviour, a logged drop.
   */
  onBetweenTurnEvent?: (event: AgentEvent) => void;
}

/**
 * Sink for this module's account of itself.
 *
 * `warn` is the historical contract (a skipped line, a lost event). `debug` is
 * the D1 addition and is deliberately a SEPARATE level: the approval
 * round-trip and the turn boundaries are per-tool-call chatter, worth having
 * only when reconstructing an incident, and at warning level they would bury
 * the lines that mean something is genuinely wrong.
 *
 * Optional, because every pre-existing caller passes a bare `{ warn }`.
 */
export interface SessionLogger {
  warn(message: string): void;
  debug?(message: string): void;
}

/**
 * One CLI process, and the turns run on it.
 *
 * A `payload`/`turn` session hosts exactly one turn and dies with it — that is
 * every caller that predates run-scoped sessions. A `session` one stays alive
 * between turns, idle, holding its MCP servers up.
 */
export interface CliSession {
  /**
   * Open a turn on this process. Null when the process cannot take one: it is
   * gone, its stdin has been closed, or a turn is already in flight. Callers
   * treat null as "spawn a fresh process" rather than asking twice.
   */
  startTurn(turn: CliTurnOptions): AgentTurnHandle | null;
  /** Alive, with no turn in flight — ready to take another one. */
  readonly idle: boolean;
  /** The process has not been observed to end. */
  readonly alive: boolean;
  /**
   * Alive, but `startTurn` will refuse every further turn — the last turn was
   * ended for the CLI rather than by it, so this process may still print that
   * turn's tail. The owner closes such an entry instead of counting it as a
   * reusable one.
   */
  readonly retired: boolean;
  /** Terminate the process group (the CLI plus every grandchild). */
  close(): void;
  /** Resolves once the process is gone. Never rejects. */
  readonly closed: Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toUtf8(chunk: string | Buffer): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
}

/** Bytes of a child's stderr retained for the failure message on a non-zero exit. */
const STDERR_TAIL_BYTES = 2000;

/**
 * How long an in-protocol interrupt is given to end the turn before the cancel
 * falls back to killing the process group.
 *
 * The fallback is what keeps Stop honest: an interrupt the CLI acknowledges but
 * never acts on would otherwise leave the turn running with the user told it
 * had stopped. Generous relative to the 2ms the acknowledgement itself took,
 * because the CLI still has to unwind whatever tool call it was inside.
 */
const INTERRUPT_SETTLE_GRACE_MS = 5000;

/**
 * How long `exit` waits for `close` before settling the turn itself.
 *
 * `close` is the preferred settle point because it guarantees stdout has fully
 * drained; `exit` only says the CLI is gone. The window exists so the ordinary
 * case still settles on `close` with everything parsed — it is a BACKSTOP for
 * the case where `close` is never coming at all, not a race against it.
 *
 * Generous on purpose: settling early would cut off trailing stdout, and the
 * cost of waiting is a spinner that stops two seconds later rather than never.
 */
const EXIT_SETTLE_GRACE_MS = 2000;

/**
 * How long a `turn`-lifetime CLI is given to exit BY ITSELF after its turn's
 * terminal event, before its process group is terminated.
 *
 * A `turn` process exists to serve exactly one turn, and that turn settles when
 * the process ENDS — so a CLI that ends its turn and then goes on living wedges
 * the turn open forever. Closing stdin is all that used to be done about it,
 * which assumes a CLI that treats EOF as "we're finished". `cursor-agent acp`
 * does not (probe-recorded in `cursor-acp.const.ts`, and measured again here:
 * 3m25s after its turn reported `end_turn`, the process was still alive at
 * 163MB with a `worker-server` grandchild beside it). The consequences were both
 * halves of one report — the run's `ProcessRegistry` slot was never released, so
 * every later message in that chat answered `RUN_BUSY` and sat in the composer's
 * queue with the spinner still running, and each turn leaked a process group
 * that outlived the daemon (four such groups found reparented to launchd, 1.5
 * days old).
 *
 * So the terminal event arms this instead of merely closing stdin. A CLI that
 * does exit on EOF — claude — is gone long before it fires and never notices;
 * the turn still settles on the process actually ending, so the guarantee that
 * `done` implies fully-drained stdout is unchanged.
 *
 * 2s for the same reason `EXIT_SETTLE_GRACE_MS` is 2s: long enough that a CLI
 * intending to exit always wins the race, short enough to stay inside the
 * renderer's own RUN_BUSY retry budget (300+600+1200+2400ms), so a message
 * queued in this window still goes out on its own.
 */
const TURN_END_EXIT_GRACE_MS = 2000;

/**
 * How long a run-scoped turn may go completely SILENT before the turn is
 * settled as failed and the user gets their composer back.
 *
 * The gap this closes: on a `session` lifetime a turn ends on its terminal
 * EVENT, so a process that stays alive and simply never emits one leaves the
 * turn open forever. Both other backstops hang off `handle.done`, which is
 * exactly what never resolves in that state — so nothing bounds it.
 *
 * Measured against SILENCE rather than against the turn's total length, and
 * that distinction is the whole design. A wall-clock cap cleared only by the
 * terminal event would settle a turn that is working perfectly well — an agent
 * legitimately runs for hours — and the user would watch real work be
 * abandoned. Any event at all rearms this, so it fires only when the CLI has
 * genuinely stopped talking.
 *
 * Generous for the same reason: a single tool call (a full test suite, a long
 * build) can be silent for many minutes, and settling one of those early costs
 * the user their turn. Half an hour of nothing is not a slow turn.
 *
 * The process is deliberately LEFT ALIVE on expiry — it holds the run's MCP
 * servers, and the next turn reuses it. Only the turn is given up on.
 */
const TURN_SILENCE_DEADLINE_MS = 30 * 60 * 1000;

/** The mutable state of the one turn currently in flight. */
interface TurnState {
  /** When this turn opened — the denominator of the settle line. */
  startedAt: number;
  settled: boolean;
  /**
   * Emit at most ONE terminal event per turn, whichever arrives first: a
   * `result`-line `turn_complete` from the mapper, a signal-kill
   * `turn_cancelled`, or an `error`. Without this gate a child that prints a
   * success `result` AND then exits non-zero (or fires `error` then `close`)
   * would emit two contradictory terminal items for one turn.
   */
  terminalEmitted: boolean;
  /**
   * A cancel() was requested: the CLI usually reacts by printing an is_error
   * result line (or exiting non-zero) BEFORE the stop reaches us, and that
   * error would win the one-terminal race — recording a fake failure for a
   * deliberate stop. So after a cancel an `error` terminal is normalized to
   * `turn_cancelled`; a genuine `turn_complete` that raced it still wins (the
   * turn really finished).
   */
  cancelRequested: boolean;
  resolveDone: () => void;
  options: CliTurnOptions;
  /** Fallback deadline armed when an in-protocol interrupt was delivered. */
  interruptTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Rearmed by every event this turn produces; fires only after
   * {@link TURN_SILENCE_DEADLINE_MS} of nothing. Null for a lifetime whose
   * turn already ends with its process.
   */
  silenceTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Every approval request this turn has been shown and not yet answered —
   * whether it was adopted from the hold buffer or raised inside the turn.
   *
   * Both kinds leave the CLI blocked on a verdict, and a turn can settle
   * without producing one: the user presses Stop, or the turn finishes on its
   * own while a sub-agent is still parked on the card, or the silence deadline
   * gives up on it while deliberately leaving the process alive. Whatever the
   * route, dropping the request strands a live CLI on a question nothing can
   * ever answer — the wedge this whole seam exists to remove, one turn later.
   * So the remainder is drained back onto the hold buffer at settle, and
   * `respondApproval` prunes whatever it actually delivered.
   *
   * The in-turn case is the commoner door, not an edge: it needs no
   * between-turns race at all, just a turn that ends before its user does.
   */
  outstanding: Map<string, ApprovalRequestEvent>;
  /**
   * Background work this turn started that has not reported back — see
   * `AgentEvent`'s `background_work`.
   *
   * A turn is not over while this is non-empty, however plainly the CLI's
   * turn-end line says otherwise: the process keeps working, and on claude it
   * runs whole further turns of its own as each unit reports. Whatever it
   * produces then would be a between-turn orphan — mostly dropped, and reported
   * to the user as a `completed` run that was visibly still working.
   */
  openWork: Set<string>;
  /**
   * The terminal event held back because {@link openWork} was not empty, to be
   * emitted when the last unit reports (or when the silence deadline gives up
   * on them).
   *
   * The FIRST one is kept, not the last: it is the one that answers the user's
   * prompt and carries that turn's usage. A CLI's later self-initiated turns
   * report their own results, whose text ("Background note (no action
   * needed)…") is not this turn's answer and whose usage is not this turn's
   * context.
   */
  deferredTerminal: AgentEvent | null;
}

/**
 * Spawn a headless CLI agent, reassemble its stdout NDJSON, map each object to
 * normalized {@link AgentEvent}s, and surface a single settle point per turn.
 *
 * Terminal conditions are normalized: a signal-kill (cancel/shutdown) yields a
 * `turn_cancelled`, a non-zero exit yields an `error` (with the stderr tail),
 * and a clean exit relies on the `result` line the mapper already turned into
 * `turn_complete`. A turn handle's `done` never rejects — every outcome is an
 * event first.
 *
 * **What settles a turn depends on the stdin lifetime**, and the difference is
 * the whole reason this function has one:
 *
 * - `payload` / `turn` — the process serves this turn alone, so `done` waits
 *   for the process to END (`close`, or the `exit` backstop). That is what
 *   every caller before run-scoped sessions relies on: by the time `done`
 *   resolves, stdout has fully drained and the child is gone.
 * - `session` — the process outlives the turn, so `done` resolves on the
 *   TERMINAL EVENT. Waiting for the process would never resolve at all.
 */
export function runCliSession(opts: CliSessionOptions): CliSession {
  const spawnFn = opts.spawn ?? defaultSpawn;
  const settlesOnTerminalEvent = opts.stdinLifetime === 'session';

  let current: TurnState | null = null;
  /**
   * The wire encoder for an approval verdict, kept at SESSION scope.
   *
   * It is the adapter's pure `(id, allow, input) => line` — the CLI's wire
   * format, identical for every turn of one process — so holding the most
   * recent turn's copy carries no turn state with it. It exists so a permission
   * request arriving with NO turn in flight can still be ANSWERED — per the
   * owner's posture, or held for the next turn — rather than dropped; see
   * {@link handleOrphanEvent}.
   */
  let approvalEncoder: CliTurnOptions['buildApprovalResponse'];
  /**
   * Notices raised with NO turn to carry them, held for the next one.
   *
   * A turn owns `onEvent`, so an event arriving between turns has nowhere to go
   * — which is why an orphaned question was previously visible only as a daemon
   * log line. Buffering is not a delay dressed up: the CLI is left blocked on
   * that request, so the very next turn is the one that will produce nothing,
   * and this is the sentence that explains why. Delivering it there puts the
   * explanation exactly where the user meets the symptom.
   */
  const pendingNotices: string[] = [];
  /**
   * Approval requests held for the next turn to adopt, because no verdict could
   * be produced without one.
   *
   * Unlike a notice this is not an explanation — it is the request itself, and
   * the CLI is blocked on it. Held rather than refused: a refusal reaches the
   * agent as the USER's "no", for a card nobody ever saw. Replayed into the next
   * turn, it becomes an ordinary `approval_request` and takes the same card path
   * every in-turn request takes, so the user finally sees what was asked and the
   * verdict they give reaches a live stdin.
   *
   * Safe to replay where a general event is not: a verdict is answered by `id`,
   * so adopting one attributes nothing to the wrong turn — whereas replaying,
   * say, a `tool_result` would file one turn's output under another's.
   */
  const pendingApprovals: ApprovalRequestEvent[] = [];
  /**
   * When each outstanding approval request was seen, for the round-trip line.
   *
   * The D1 investigation had to reconstruct "was this request ever answered,
   * and how fast" from transcript rows, because nothing recorded the SUCCESSFUL
   * side of the exchange — only the failures were visible, which is precisely
   * the ratio that turned out to be the diagnosis.
   */
  const approvalSeenAt = new Map<string, number>();
  let processGone = false;
  /**
   * The child's `exit` has fired — set SYNCHRONOUSLY, ahead of the settle.
   *
   * `processGone` cannot answer "can this process still take a turn": it stays
   * false for the whole {@link EXIT_SETTLE_GRACE_MS} window while `close` is
   * awaited, and on a `session` lifetime `stdinEnded` stays false too. For
   * those two seconds the session reported itself idle AND alive, so the
   * registry would hand a caller a handle on a process that had already
   * ended. `processGone` still owns the settle/flush semantics; this owns the
   * question of whether the process is there.
   */
  let processExited = false;
  let stdinEnded = false;
  /**
   * A cancelled turn ended, and this process may still print the rest of it.
   *
   * Set when a turn that was asked to stop settles, and never cleared: the
   * session is retired from REUSE, so a straggler can only ever arrive with no
   * turn open and reach {@link handleOrphanEvent}.
   *
   * WHAT THIS COSTS, stated plainly because it is a real regression against the
   * kept-session feature: `startTurn` refusing is read by
   * `AgentSessionRegistry` as "close and replace", so the NEXT message after a
   * Stop pays a full respawn — the user's MCP servers go down and boot again
   * (measured at 6.5s for ten servers on claude 2.1.223). Stop alone costs
   * nothing: the process stays alive and idle, and if the chat is never
   * continued only the idle window reaps it. So this defers the group kill that
   * `cancel` below refuses to do, rather than avoiding it.
   *
   * Why that trade and not the cheaper drain. Routing late events to the orphan
   * path while KEEPING the session reusable is the version that would cost
   * nothing, and it needs a way to know the tail has ended. There is none on
   * this wire: a stream-json line carries no turn id, so once a second turn is
   * open, `emit` cannot tell that turn's own output from the previous one's
   * tail — and guessing wrong in that direction is worse than a respawn,
   * because it silently answers the user's new message with the old turn's
   * result. Bounding the drain by time instead would need a grace nobody has
   * measured AND a registry that waits rather than replaces. Both are open
   * options; neither is free, and correctness came first here.
   *
   * The defect this replaced, for the record: after a Stop the cancelled turn's
   * trailing `result` line settled the NEXT turn the moment it opened (a
   * message that got no answer at all), and its closing text was persisted with
   * the new turn's seq, so it rendered underneath a message sent after it.
   */
  let cancelledTurnMayStillEmit = false;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;
  /** See {@link TURN_END_EXIT_GRACE_MS} — one per process, which serves one turn. */
  let turnExitTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const settleTurn = (turn: TurnState, reason: string): void => {
    if (turn.settled) {
      return;
    }
    turn.settled = true;
    // The turn boundary, with WHY. The D1 investigation had to infer "was a
    // turn open when this tool call happened" from transcript rows, and the
    // reason — a `result` line, the silence deadline, the process ending —
    // was not recoverable at all.
    opts.logger?.debug?.(
      `${opts.command}: turn settled (${reason}) after ${Date.now() - turn.startedAt}ms`,
    );
    if (turn.interruptTimer) {
      clearTimeout(turn.interruptTimer);
      turn.interruptTimer = null;
    }
    if (turn.silenceTimer) {
      clearTimeout(turn.silenceTimer);
      turn.silenceTimer = null;
    }
    if (current === turn) {
      current = null;
    }
    // Asked to stop — see {@link cancelledTurnMayStillEmit}.
    //
    // Keyed on the cancel alone, NOT on the broader "did not end by itself".
    // The silence deadline settles a turn the same way and leaves the same tail
    // coming, so it shares this defect — but the deadline path deliberately
    // keeps the process reusable ("Only the turn was given up on, so the next
    // one still reuses it", pinned in `spawn-cli.session.spec.ts`), and
    // retiring there would reverse that decision and make a >30-minute tool
    // call cost a respawn. That reversal is a separate call to make with
    // evidence, not a side effect of this fix.
    const retiring = turn.cancelRequested;
    if (retiring) {
      cancelledTurnMayStillEmit = true;
    }
    // Anything this turn was shown but never answered goes back on the hold
    // buffer, ahead of whatever arrived later, so the next turn offers it
    // again. The CLI is still blocked on it either way; the only question is
    // whether it can ever be reached again.
    //
    // Which is exactly why a RETIRING settle must not say that: this session
    // will serve no next turn, and `pendingApprovals` is drained nowhere else,
    // so re-holding would park the request where nothing can reach it while the
    // log claimed it had been re-offered. Say it is abandoned instead — the
    // process is replaced on the next message, which is what unblocks the CLI.
    if (turn.outstanding.size > 0) {
      if (retiring) {
        opts.logger?.warn(
          `${opts.command}: ${turn.outstanding.size} approval request(s) went unanswered when the turn was ended — abandoned with the session, which will not serve another turn`,
        );
      } else {
        pendingApprovals.unshift(...turn.outstanding.values());
        opts.logger?.warn(
          `${opts.command}: ${turn.outstanding.size} approval request(s) went unanswered when the turn settled — re-held for the next turn`,
        );
      }
      turn.outstanding.clear();
    }
    // The map only ever times a WITHIN-turn round trip, so nothing in it can
    // still be answered once the turn is over. `respondApproval` and the
    // between-turns handler each delete their own entry, but a request settled
    // off both paths — `ApprovalRegistry.sweepNode`'s `unanswerable`, a
    // deny-on-persist-throw, a cancel with a card still open — left one behind,
    // and a run-scoped session holds this closure for every turn of the chat.
    approvalSeenAt.clear();
    // `killTimer` is deliberately NOT cleared here. It belongs to the PROCESS,
    // not the turn: a cancel that settled the turn in protocol (or a
    // `close()` taken while a turn was running) still needs its SIGTERM to
    // escalate if the group ignores it. Only the process actually ending
    // disarms it — see `endProcess`.
    turn.resolveDone();
  };

  /**
   * Make sure a one-turn process actually goes away once its turn is over — see
   * {@link TURN_END_EXIT_GRACE_MS}.
   *
   * Armed from the terminal event, beside the stdin close it is the backstop
   * for. Idempotent and a no-op once the process is accounted for, so a second
   * terminal condition cannot arm a second kill.
   */
  const armTurnExitDeadline = (): void => {
    if (turnExitTimer !== null || processGone) {
      return;
    }
    turnExitTimer = setTimeout(() => {
      turnExitTimer = null;
      if (processGone) {
        return;
      }
      opts.logger?.debug?.(
        `${opts.command}: its turn ended but the process did not — terminating the group`,
      );
      killGroup();
    }, TURN_END_EXIT_GRACE_MS);
  };

  /**
   * Arm (or rearm) the silence deadline for a turn that ends on an event.
   * A no-op for the other lifetimes, whose turn ends with its process and is
   * already bounded by `close`/`exit`.
   */
  const armSilenceDeadline = (turn: TurnState): void => {
    if (!settlesOnTerminalEvent || turn.settled) {
      return;
    }
    if (turn.silenceTimer) {
      clearTimeout(turn.silenceTimer);
    }
    turn.silenceTimer = setTimeout(() => {
      turn.silenceTimer = null;
      if (turn.settled || turn.terminalEmitted) {
        return;
      }
      // This turn already produced its result and was only waiting on background
      // work that has now gone silent too. It FINISHED — release the held
      // terminal rather than overwriting a completed turn with a failure whose
      // sentence ("produced nothing…") would be false about it twice over: it
      // produced an answer, and what stopped talking was the work, not the turn.
      const held = turn.deferredTerminal;
      if (held) {
        opts.logger?.warn(
          `${opts.command}: releasing the held '${held.type}' — ${turn.openWork.size} unit(s) of background work never reported`,
        );
        finishTurn(turn, held);
        return;
      }
      // Through `emit`, so this takes the one-terminal gate with every other
      // outcome and cannot contradict a `result` line that arrives beside it.
      emit({
        type: 'error',
        message: `${opts.command} produced nothing for ${Math.round(
          TURN_SILENCE_DEADLINE_MS / 60_000,
        )} minutes — giving up on the turn`,
      });
    }, TURN_SILENCE_DEADLINE_MS);
    turn.silenceTimer.unref?.();
  };

  /**
   * An event arrived with NO turn in flight — the process outlived the turn
   * geniro was tracking and kept working.
   *
   * Measured, not hypothetical: across the author's own `geniro.db`, 1589 of
   * 4505 tool results arrived in this state, and they carried 165 of the 181
   * `Tool permission request failed: AbortError: Stream closed` failures
   * (10.4% here against 0.5% inside an open turn).
   *
   * Most events genuinely have nobody to tell, and holding them for the next
   * turn would attribute one turn's output to another — so they stay dropped.
   * An `approval_request` is the exception, because dropping it is not
   * neutral: the CLI is BLOCKED on a reply that, with no turn, nothing will
   * ever send.
   *
   * What to answer is the OWNER's call ({@link CliSessionOptions.betweenTurnApproval}),
   * because it turns on the run's approval posture and this layer cannot see
   * one. Deciding here alone was wrong in both directions: under `auto` — whose
   * entire contract is to approve plain permissions unattended — every
   * between-turn tool call was REFUSED, and the refusal reached the agent as
   * the user's own "no" for a card that was never rendered. That is the
   * "Denied by the user in Geniro" a user saw while their agent reported it had
   * lost write access to the worktree.
   *
   * A request the owner will not decide is HELD rather than refused, and the
   * next turn adopts it — see {@link pendingApprovals}.
   */
  function handleOrphanEvent(event: AgentEvent): void {
    if (event.type !== 'approval_request') {
      if (opts.onBetweenTurnEvent) {
        opts.onBetweenTurnEvent(event);
        return;
      }
      opts.logger?.warn(
        `${opts.command}: dropped a '${event.type}' event arriving between turns`,
      );
      return;
    }
    const isQuestion = isUserQuestion(
      opts.questionToolName ?? null,
      event.toolName,
    );
    // The default is the pre-owner behaviour, kept for callers with no posture
    // to offer: a question is held (refusing answers for the user), a
    // permission is refused (no turn can carry a verdict).
    // Not `?? default` — null is a VERDICT here ("hold it"), and `??` would
    // read it as an absent policy and fall through to the refusal this exists
    // to remove.
    const offered = opts.betweenTurnApproval
      ? opts.betweenTurnApproval({ toolName: event.toolName })
      : isQuestion
        ? null
        : false;
    // A floor no owner can lower: a QUESTION is never answered without the
    // user, whatever the posture says. The previous code refused questions
    // unconditionally and so could not get this wrong; now that an owner
    // decides, the one verdict that would speak for the user has to be
    // unavailable rather than merely unused by today's only caller.
    const verdict = isQuestion && offered === true ? null : offered;
    if (verdict !== offered) {
      opts.logger?.warn(
        `${opts.command}: refusing to auto-answer the question tool '${event.toolName}' between turns — held for the user instead`,
      );
    }
    if (verdict === null) {
      approvalSeenAt.delete(event.id);
      pendingApprovals.push(event);
      opts.logger?.warn(
        `${opts.command}: ${isQuestion ? 'question' : 'approval_request'} for '${event.toolName}' ` +
          `(id ${event.id}) arrived between turns — held for the next turn to adopt`,
      );
      // Oldest first, and SAID rather than silently trimmed. Every held
      // request is a CLI blocked on a verdict, so dropping one is giving up on
      // it — a fact the log has to carry, because the user's only other clue
      // would be an agent that never finished. The cap exists because nothing
      // else bounds this: a CLI asking repeatedly on a chat nobody returns to
      // would grow the buffer for as long as the session lives.
      while (pendingApprovals.length > MAX_HELD_APPROVALS) {
        const dropped = pendingApprovals.shift()!;
        opts.logger?.warn(
          `${opts.command}: dropped held request '${dropped.toolName}' (id ${dropped.id}) — ` +
            `more than ${MAX_HELD_APPROVALS} are outstanding and the CLI is still blocked on it`,
        );
      }
      // ONE notice per turn however many are held: the sentence explains the
      // state, not each occurrence, and N verbatim copies of it would bury the
      // cards it is pointing at.
      // Short, and INFORMATIONAL — see the severity below. The three-clause
      // version this replaces explained the whole mechanism (nothing was on
      // screen; it was not answered for you; it is shown above), in the daemon's
      // failure chrome, immediately above the card it points at. Reported back
      // as an error the user "still sees sometimes", which is fair: nothing went
      // wrong, the request was kept and handed over exactly as intended.
      const notice = `${opts.command} asked this between turns — kept for you rather than answered on your behalf.`;
      if (!pendingNotices.includes(notice)) {
        pendingNotices.push(notice);
      }
      return;
    }
    // The request's OWN input rides back, exactly as the in-turn auto-approve
    // seam does it. Passing undefined was harmless while this branch only ever
    // denied (a deny drops the field), but an ALLOW echoes it — and the
    // adapter's `updatedInput ?? {}` would have handed the CLI a blanked
    // argument list for a call it had just been given permission to make.
    const line = approvalEncoder?.(event.id, verdict, event.input);
    const answered = line !== undefined && sessionWrite(line);
    approvalSeenAt.delete(event.id);
    // WARN, not debug: the CLI asked permission for work no turn owns, which
    // is the state the D1 numbers point at. Every field a later reader needs
    // to join this to a transcript row is on the line — tool and request id
    // were both missing from the message this replaces.
    opts.logger?.warn(
      `${opts.command}: approval_request for '${event.toolName}' (id ${event.id}) arrived between turns — ` +
        (answered
          ? `${verdict ? 'allowed' : 'refused'} by the run's standing approval posture`
          : 'and could NOT be answered (no approval encoder or stdin is gone) — the CLI is parked'),
    );
  }

  /**
   * Hand a turn its terminal event and settle it — the one door every outcome
   * takes, whether it arrived now or was held for background work.
   *
   * Extracted so a deferred terminal cannot take a shorter path than a prompt
   * one: the one-terminal gate, the stdin close and the settle are the same
   * three steps either way.
   */
  const finishTurn = (turn: TurnState, event: AgentEvent): void => {
    if (turn.terminalEmitted) {
      return;
    }
    turn.terminalEmitted = true;
    turn.deferredTerminal = null;
    if (opts.stdinLifetime === 'turn') {
      endStdin();
      // Closing stdin only ASKS a one-turn CLI to finish; one that ignores EOF
      // would otherwise hold this turn — and the run's registry slot — open
      // for good. See {@link TURN_END_EXIT_GRACE_MS}.
      armTurnExitDeadline();
    }
    turn.options.onEvent(event);
    if (settlesOnTerminalEvent) {
      settleTurn(turn, `terminal event '${event.type}'`);
    }
  };

  /**
   * Deliver an event to the turn it belongs to; see {@link handleOrphanEvent}
   * for what happens when there is no turn to deliver it to.
   */
  const emit = (event: AgentEvent): void => {
    if (event.type === 'approval_request') {
      approvalSeenAt.set(event.id, Date.now());
    }
    const turn = current;
    if (!turn) {
      handleOrphanEvent(event);
      return;
    }
    if (event.type === 'approval_request') {
      // Recorded HERE, at the one door every request bound for a turn passes
      // through — adopted from the hold buffer or raised mid-turn alike. Doing
      // it at the adoption site instead covered only the rarer of the two, and
      // left an in-turn request that its turn never answered stranding the CLI
      // for good (see {@link TurnState.outstanding}).
      turn.outstanding.set(event.id, event);
    }
    // Turn plumbing, consumed here and never forwarded: it says whether the
    // turn's work is over, which is this function's business and no consumer's.
    if (event.type === 'background_work') {
      if (event.phase === 'started') {
        turn.openWork.add(event.id);
      } else if (turn.openWork.delete(event.id) && turn.openWork.size === 0) {
        // The last unit reported, so a held terminal event is now due. Only
        // reached when this settle actually closed something we were waiting on
        // — a stray `settled` for unknown work must not release the turn.
        const held = turn.deferredTerminal;
        if (held) {
          opts.logger?.debug?.(
            `${opts.command}: releasing the held '${held.type}' — its background work has reported`,
          );
          finishTurn(turn, held);
          return;
        }
      }
      armSilenceDeadline(turn);
      return;
    }
    const normalized: AgentEvent =
      turn.cancelRequested && event.type === 'error'
        ? { type: 'turn_cancelled' }
        : event;
    if (
      normalized.type === 'turn_complete' ||
      normalized.type === 'turn_cancelled' ||
      normalized.type === 'error'
    ) {
      if (turn.terminalEmitted) {
        return;
      }
      // The CLI has stopped TALKING while work it started is still running, and
      // on a session lifetime the process is still there doing it. Hold the
      // terminal event: emitting it now ends the turn mid-work, and everything
      // the process produces next — including whole turns claude runs of its own
      // accord as each unit reports — arrives with no turn to own it.
      //
      // Only a `turn_complete`, and only on a session lifetime. A cancel is the
      // user asking to stop NOW, an `error` is a turn that has failed rather
      // than finished, and a turn whose process ends with it has no "after" to
      // wait for — deferring in any of those three cases would hold a turn open
      // for work that is already over.
      if (
        normalized.type === 'turn_complete' &&
        settlesOnTerminalEvent &&
        turn.openWork.size > 0
      ) {
        if (turn.deferredTerminal === null) {
          turn.deferredTerminal = normalized;
          opts.logger?.debug?.(
            `${opts.command}: holding the turn open — ${turn.openWork.size} unit(s) of background work have not reported`,
          );
        }
        armSilenceDeadline(turn);
        return;
      }
      finishTurn(turn, normalized);
      return;
    }
    // The CLI is still talking, so it has not wedged — push the deadline out.
    armSilenceDeadline(turn);
    turn.options.onEvent(normalized);
  };

  let child: SpawnedProcess;
  try {
    child = spawnFn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: buildChildEnv(opts.env),
    });
  } catch (err) {
    // The session never existed, so none of the state above ever applies to it
    // — the whole closure is abandoned for a stand-in. The failure still
    // reaches the caller the way every other terminal condition does: as an
    // `error` event on the first turn's own handle, never as a throw.
    return deadSession(`failed to spawn ${opts.command}: ${errorMessage(err)}`);
  }

  // The whole group, not the direct child: a single-PID SIGTERM would orphan
  // the tool/MCP grandchildren the agent forked.
  //
  // `processGone` — not `processExited` — is the right predicate, and the
  // difference matters. `processExited` means the CLI itself is gone; the
  // GROUP may still be full of grandchildren holding the inherited stdio open,
  // and those are exactly what the escalation is for. `processGone` means the
  // session has been accounted for (`close`, or the exit backstop), by which
  // point there is nothing left to escalate against.
  const terminator = createGroupTerminator(child, {
    isGone: () => processGone,
  });

  const buffer = new NdjsonBuffer({
    onObject: (obj) => {
      for (const event of opts.mapper(obj)) {
        emit(event);
      }
    },
    onParseError: (line) =>
      opts.logger?.warn(
        `${opts.command}: skipped unparseable stream line: ${line.slice(0, 200)}`,
      ),
  });

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string | Buffer) => {
    // Any stdout at all proves the CLI has not wedged, whether or not the
    // mapper makes an event of it — a line this daemon does not recognise is
    // still the process talking, and settling a turn over one would be a
    // vocabulary gap presented to the user as a hang.
    if (current) {
      armSilenceDeadline(current);
    }
    buffer.push(toUtf8(chunk));
  });

  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string | Buffer) => {
    stderrTail = (stderrTail + toUtf8(chunk)).slice(-STDERR_TAIL_BYTES);
  });

  /** The process is gone: settle whatever was running and close the session. */
  const endProcess = (): void => {
    if (!processGone) {
      processGone = true;
      stdinEnded = true;
      if (exitTimer) {
        clearTimeout(exitTimer);
        exitTimer = null;
      }
      if (turnExitTimer) {
        clearTimeout(turnExitTimer);
        turnExitTimer = null;
      }
      terminator.disarm();
      resolveClosed();
    }
    if (current) {
      settleTurn(current, 'the process ended');
    }
  };

  child.on('error', (err: Error) => {
    if (processGone) {
      return;
    }
    if (current && !current.settled) {
      emit({
        type: 'error',
        message: `${opts.command} process error: ${err.message}`,
      });
    }
    endProcess();
  });

  // `close` fires after stdio is fully drained AND the process has exited, so
  // every stdout line is parsed before the terminal event — `exit` can race the
  // last chunk. Guard on `processGone`: a child can surface a process-level
  // `error` and THEN fire `close` with a non-zero code; without this guard both
  // handlers emit a terminal event and the transcript records two
  // contradictory ones.
  const settleFromTermination = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    buffer.flush();
    if (current && !current.terminalEmitted) {
      if (signal) {
        emit({ type: 'turn_cancelled' });
      } else if (code !== null && code !== 0) {
        const detail = stderrTail.trim();
        emit({
          type: 'error',
          message: `${opts.command} exited with code ${code}${detail ? `: ${detail}` : ''}`,
        });
      } else if (current.deferredTerminal) {
        // A CLEAN exit while a terminal event was held for background work: the
        // process is gone, so the work is over one way or another, and the turn
        // DID complete — release what it produced. Falling through to the branch
        // below would replace a real `turn_complete` (with the turn's usage) with
        // "exited without completing the turn", which is exactly backwards.
        finishTurn(current, current.deferredTerminal);
      } else {
        // A CLEAN exit with no terminal event: the process ended without ever
        // printing the result line the mapper turns into `turn_complete`.
        // Saying nothing here is not neutral — `ChatService` fills the silence
        // with a synthetic `turn_complete` and records a success the agent
        // never produced, which reads to the user as an answered turn with no
        // answer in it.
        const detail = stderrTail.trim();
        emit({
          type: 'error',
          message: `${opts.command} exited without completing the turn${detail ? `: ${detail}` : ''}`,
        });
      }
    }
    endProcess();
  };

  child.on('close', (code, signal) => {
    if (processGone) {
      return;
    }
    settleFromTermination(code, signal);
  });

  // The BACKSTOP for a `close` that never arrives.
  //
  // `close` fires only once the process has exited AND every piped stdio fd has
  // lost its last writer. A coding agent forks tool/MCP grandchildren that
  // inherit those fds, and any one of them outliving the CLI holds `close` open
  // indefinitely — the process is gone, its turn is over, and nothing says so.
  // Everything hangs off this one settle: the run row stays `running`, the
  // transcript never gets a terminal item, the registry slot is never released
  // (so every later send answers RUN_BUSY), and the composer spins forever.
  //
  // The codebase already learned this on the utility path and did not carry it
  // here — see `agent-adapter.ts`'s `child.on('exit', () => reapGroup())` and
  // its note that `close` "waits for the stdio pipes, which a lingering
  // health-check grandchild holds open".
  //
  // `close` stays the PREFERRED path: this only arms a timer, so the ordinary
  // turn still settles on `close` with stdout fully drained, and the timer is
  // cleared once the process is accounted for. Deliberately signals NOTHING —
  // reaping the group here would SIGKILL the user's own MCP servers, and
  // through them a browser session they are driving. A stray grandchild costs
  // memory; the child journal and its next-boot reaper already own that.
  child.on('exit', (code, signal) => {
    // Before the early return, and before the timer: the process is gone as of
    // now whatever the settle does about it, and every reader below asks this
    // rather than waiting out the grace window.
    processExited = true;
    if (processGone || exitTimer) {
      return;
    }
    exitTimer = setTimeout(() => {
      exitTimer = null;
      if (processGone) {
        return;
      }
      settleFromTermination(code, signal);
    }, EXIT_SETTLE_GRACE_MS);
    exitTimer.unref?.();
  });

  /**
   * The one write path to the child's stdin, shared by every turn and by a
   * client-initiated protocol driver. Re-reads `child.stdin` per call so a
   * stream torn down mid-turn is caught here rather than by a stale reference,
   * and never throws — a closed pipe is a dropped write, and the process's own
   * termination handlers own the terminal event.
   *
   * Guarded on the PROCESS, not on a turn: opening the next turn on an idle
   * session is a legitimate write with no turn in flight. The three
   * turn-scoped writers below add their own guard on top.
   */
  const sessionWrite = (payload: string): boolean => {
    if (processGone || processExited || stdinEnded) {
      return false;
    }
    const stream = child.stdin;
    // `writable` is the question, and the try/catch below cannot stand in for
    // it: writing past an ended or destroyed pipe does NOT throw — node
    // reports it asynchronously and the call returns — so the catch never
    // fires and a write that never landed was answered `true`. The caller
    // ACTS on this answer: `sendUserMessage` returning true has the chat
    // commit a user message the CLI never received.
    //
    // The write's own return value is deliberately not consulted: a false
    // there is backpressure, meaning buffered-not-yet-flushed, which is a
    // delivered write and not a failed one.
    if (!stream || !stream.writable) {
      return false;
    }
    try {
      stream.write(payload);
      return true;
    } catch {
      return false;
    }
  };

  function endStdin(): void {
    if (stdinEnded) {
      return;
    }
    stdinEnded = true;
    try {
      child.stdin?.end();
    } catch {
      // Already closed with the child's exit — nothing to end.
    }
  }

  const stdin = child.stdin;
  if (stdin) {
    // A stdin that errors asynchronously (EPIPE — the CLI exited before we
    // finished writing) would otherwise throw an unhandled stream error and
    // crash the daemon; surface it as a normal terminal error instead.
    stdin.on('error', (err: Error) => {
      if (processGone) {
        return;
      }
      // An errored stdin can never be written again, so the session must stop
      // reporting itself usable — `idle` and `startTurn` both read this flag.
      //
      // This is the case a SESSION lifetime introduced and the guard below was
      // never widened for: the process outlives the turn, so its pipe can break
      // BETWEEN turns, with no `current` to carry the event. Every exit here
      // was then a bare `return` — nothing recorded, nothing marked — so the
      // registry went on handing out a session whose pipe was broken, later
      // writes were answered `true` into a pipe nobody was reading, and the
      // run went quiet with no trace anywhere. For a `turn` or `payload`
      // lifetime this changes nothing: `endStdin` has already set the flag by
      // the time either could reach this line.
      stdinEnded = true;
      const failure: AgentEvent = {
        type: 'error',
        message: `${opts.command} stdin error: ${err.message}`,
      };
      if (!current) {
        // No turn at all — the between-turns break a SESSION lifetime makes
        // possible. Logged DIRECTLY rather than emitted: with no turn to carry
        // it, `emit` routes to `handleOrphanEvent`, which records the event
        // TYPE and discards the message, so the reason would still be nowhere.
        opts.logger?.warn(failure.message);
        // …and retire the session. Marking it unusable is only half: `closed`
        // is the ONE channel its owner forgets it through, and an entry that is
        // `alive` but not `idle` is skipped by both the idle timer and the
        // eviction sweep while still counting against the session ceiling — so
        // it would hold a slot for the daemon's lifetime and get a HEALTHY
        // session evicted in its place. The group is signalled too: a process
        // whose stdin we have given up on is one nobody can talk to again.
        killGroup();
        endProcess();
        return;
      }
      // After the terminal event the turn is already decided — a late EPIPE
      // (e.g. closing a kept-open stdin as the child exits) must not settle
      // early, or `close` would skip the final buffer flush and `done` would
      // resolve before stdout drains. The process is on its way out on its
      // own here, so this one only records.
      if (current.terminalEmitted) {
        opts.logger?.warn(failure.message);
        return;
      }
      emit(failure);
      endProcess();
    });
  }

  const killGroup = (): void => terminator.terminate();

  const startTurn = (turnOptions: CliTurnOptions): AgentTurnHandle | null => {
    if (
      processGone ||
      processExited ||
      stdinEnded ||
      current !== null ||
      cancelledTurnMayStillEmit
    ) {
      return null;
    }
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const turn: TurnState = {
      startedAt: Date.now(),
      settled: false,
      terminalEmitted: false,
      cancelRequested: false,
      resolveDone: () => resolveDone(),
      options: turnOptions,
      interruptTimer: null,
      silenceTimer: null,
      outstanding: new Map(),
      openWork: new Set(),
      deferredTerminal: null,
    };
    current = turn;
    // Kept at session scope so a request arriving AFTER this turn settles can
    // still be refused rather than dropped — see `handleOrphanEvent`.
    approvalEncoder = turnOptions.buildApprovalResponse;
    // Anything that happened while no turn was open is told to THIS one, before
    // its own output — it is the context for what this turn is about to do (or
    // fail to do). Drained, not copied: each is said once.
    // A request held while no turn was open is adopted FIRST, ahead of the
    // notice explaining it — the notice says "it is shown above", and a card
    // that arrived after its own explanation would make a liar of it. The CLI
    // has been blocked on each of these since it asked, so this is also the
    // earliest moment either could reach a user.
    while (pendingApprovals.length > 0) {
      const adopted = pendingApprovals.shift()!;
      // Recorded the same way `emit` records an in-turn request — this loop
      // hands the event straight to the turn rather than going through it, so
      // the bookkeeping has to be repeated rather than inherited.
      approvalSeenAt.set(adopted.id, Date.now());
      turn.outstanding.set(adopted.id, adopted);
      turnOptions.onEvent(adopted);
    }
    while (pendingNotices.length > 0) {
      // `info`, because every notice this queue carries is the between-turn
      // hand-over above: the machinery worked, and the row exists only so the
      // odd timing is not silent. The daemon's failure chrome is for degrades.
      turnOptions.onEvent({
        type: 'notice',
        message: pendingNotices.shift()!,
        severity: 'info',
      });
    }
    opts.logger?.debug?.(`${opts.command}: turn opened`);
    // Armed from the start, not from the first event: a turn whose CLI never
    // answers at all is exactly the case with nothing to rearm it.
    armSilenceDeadline(turn);

    // The write/end can also throw synchronously (stdin already destroyed).
    // Keep it inside the settle contract: surface an error event and end the
    // process rather than letting the throw unwind before the handle exists.
    try {
      if (turnOptions.stdinPayload !== undefined) {
        stdin?.write(turnOptions.stdinPayload);
      }
      if (opts.stdinLifetime === 'payload') {
        endStdin();
      }
    } catch (err) {
      if (!turn.terminalEmitted) {
        emit({
          type: 'error',
          message: `failed to write ${opts.command} stdin: ${errorMessage(err)}`,
        });
      }
      endProcess();
    }

    // After the payload, before any stdout is parsed: a protocol whose FIRST
    // message comes from the client (ACP's `initialize`) opens here. Runs
    // inside the same synchronous window as the write, so the opening message
    // is queued on stdin before the child can answer it.
    turnOptions.onStdinReady?.({ write: sessionWrite, emit });

    /** A turn-scoped write: dead once this turn is decided. */
    const turnWrite = (
      build: (() => string | undefined) | undefined,
    ): boolean => {
      if (turn.settled || turn.terminalEmitted) {
        return false;
      }
      const line = build?.();
      if (line === undefined) {
        return false;
      }
      return sessionWrite(line);
    };

    return {
      done,
      respondApproval: (id, allow, updatedInput) => {
        const delivered = turnWrite(() =>
          turnOptions.buildApprovalResponse?.(id, allow, updatedInput),
        );
        if (delivered) {
          // Answered, so it must not be re-held when this turn settles.
          // Keyed on delivery: a verdict the CLI never received leaves the
          // request outstanding, which is exactly when re-holding is right.
          turn.outstanding.delete(id);
        }
        const seenAt = approvalSeenAt.get(id);
        approvalSeenAt.delete(id);
        // Both outcomes, deliberately. Recording only the failures is what made
        // the D1 numbers unobtainable from logs: "how often is a verdict
        // delivered" has no answer unless the delivered ones are written down
        // too.
        opts.logger?.debug?.(
          `${opts.command}: approval ${id} ${allow ? 'allowed' : 'denied'} — ` +
            `${delivered ? 'written to stdin' : 'NOT written (turn already settled)'}` +
            (seenAt === undefined
              ? ''
              : ` ${Date.now() - seenAt}ms after it was raised`),
        );
        return delivered;
      },
      sendUserMessage: (message) =>
        // Guarded like the verdict above, and for the same reason: a write that
        // lands after the turn settled would be reported as delivered while the
        // agent never sees it, and the caller would drop it from its queue.
        turnWrite(() => turnOptions.buildFollowUpPayload?.(message)),
      setApprovalMode: (mode) =>
        // Same settle guard as the two writers above. It matters more here: a
        // true reported for a write the turn never read would tell the user
        // their permission posture changed when it did not.
        turnWrite(() => turnOptions.buildApprovalModePayload?.(mode)),
      cancel: () => {
        if (turn.settled) {
          return;
        }
        // An in-protocol stop is already under way, and the deadline armed
        // below is what bounds it. A second press must NOT skip that grace:
        // killing the group is exactly what takes the user's MCP servers — and
        // a browser one of them owns — down with the turn, and "stop harder"
        // is not what pressing Stop twice asks for.
        if (turn.interruptTimer) {
          return;
        }
        turn.cancelRequested = true;
        // On a run-scoped session, stopping the TURN must not stop the
        // PROCESS, for that same reason. Ask the CLI to stop in protocol, and
        // fall back to the group kill only if it cannot be asked.
        if (settlesOnTerminalEvent) {
          const line = turnOptions.buildInterruptPayload?.();
          if (line !== undefined && sessionWrite(line)) {
            turn.interruptTimer = setTimeout(() => {
              turn.interruptTimer = null;
              if (!turn.settled) {
                killGroup();
              }
            }, INTERRUPT_SETTLE_GRACE_MS);
            turn.interruptTimer.unref?.();
            return;
          }
        }
        killGroup();
      },
    };
  };

  return {
    startTurn,
    get idle() {
      return !processGone && !processExited && !stdinEnded && current === null;
    },
    get alive() {
      return !processGone && !processExited;
    },
    /**
     * This process will serve no further turn, though it is still running.
     *
     * Separate from `idle` on purpose, and it must stay that way: every reader
     * treats a NON-idle entry as BUSY, so folding retirement into `idle` would
     * stop the idle timer reaping it (`AgentSessionRegistry.arm`) while
     * `evictIfFull` went on counting it against the ceiling — the same
     * inversion the dead-session sweep exists to prevent, which its own doc
     * block spells out. The owner drops a retired entry in that same sweep.
     */
    get retired() {
      return cancelledTurnMayStillEmit;
    },
    close: () => {
      if (processGone) {
        return;
      }
      if (current) {
        current.cancelRequested = true;
      }
      killGroup();
    },
    closed,
  };
}

/**
 * The session a spawn failure leaves behind: no process, and one turn's worth
 * of bad news to deliver. Its first `startTurn` emits the spawn error and
 * hands back an already-settled handle, so the caller's single settle point
 * still fires exactly once; every later call answers null.
 */
function deadSession(message: string): CliSession {
  let used = false;
  return {
    startTurn: (turnOptions) => {
      if (used) {
        return null;
      }
      used = true;
      turnOptions.onEvent({ type: 'error', message });
      return {
        done: Promise.resolve(),
        cancel: () => {},
        respondApproval: () => false,
        sendUserMessage: () => false,
        setApprovalMode: () => false,
      };
    },
    idle: false,
    alive: false,
    // Not retired but DEAD, and the distinction matters to the holder: a
    // retired session is a live process to close, while this one has no process
    // at all. `alive: false` is what gets this entry dropped.
    retired: false,
    close: () => {},
    closed: Promise.resolve(),
  };
}

export interface RunCliOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Extra env merged over `process.env` for the child. */
  env?: Record<string, string>;
  /**
   * Written to the child's stdin before stdin is closed. When undefined, stdin
   * is closed immediately with no payload (so a CLI that reads its prompt from
   * args never blocks waiting on stdin).
   */
  stdinPayload?: string;
  /**
   * Keep stdin open after the payload so the turn can carry a mid-turn
   * dialogue (the approval control protocol). Stdin is closed as soon as a
   * terminal event is emitted, letting the CLI exit; without that close a
   * stream-json CLI waits on stdin forever.
   */
  keepStdinOpen?: boolean;
  buildApprovalResponse?: CliTurnOptions['buildApprovalResponse'];
  buildFollowUpPayload?: CliTurnOptions['buildFollowUpPayload'];
  buildApprovalModePayload?: CliTurnOptions['buildApprovalModePayload'];
  /** Maps each parsed stream-json object to zero or more normalized events. */
  mapper: (obj: unknown) => AgentEvent[];
  onStdinReady?: CliTurnOptions['onStdinReady'];
  onEvent: (event: AgentEvent) => void;
  spawn?: SpawnFn;
  logger?: SessionLogger;
}

/**
 * One CLI process serving exactly one turn — the shape every caller had before
 * run-scoped sessions, kept as a thin façade over {@link runCliSession} rather
 * than a second implementation of the same state machine.
 *
 * `done` still resolves only once the PROCESS is gone and its stdout has
 * drained, which is what callers of this form rely on.
 */
export function runHeadlessCli(opts: RunCliOptions): AgentTurnHandle {
  const session = runCliSession({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
    stdinLifetime: opts.keepStdinOpen ? 'turn' : 'payload',
    mapper: opts.mapper,
    spawn: opts.spawn,
    logger: opts.logger,
  });
  const handle = session.startTurn({
    stdinPayload: opts.stdinPayload,
    onEvent: opts.onEvent,
    buildApprovalResponse: opts.buildApprovalResponse,
    buildFollowUpPayload: opts.buildFollowUpPayload,
    buildApprovalModePayload: opts.buildApprovalModePayload,
    onStdinReady: opts.onStdinReady,
  });
  // A fresh session always accepts its first turn — the session was created on
  // the line above, so nothing can have taken the slot. Asserted rather than
  // non-null-asserted so a future change to `startTurn`'s guards surfaces here
  // instead of as a null handle inside an adapter.
  if (!handle) {
    throw new Error(`failed to open a turn on ${opts.command}`);
  }
  return handle;
}
