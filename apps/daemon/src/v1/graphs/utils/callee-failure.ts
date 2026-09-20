import type { AgentTurnFailure } from '../../agents/adapters/adapter.types';
import { redactSecrets } from '../../diagnostics/utils/redact';
import type { CalleeTurnOutcome } from '../graphs.types';

/**
 * What a CALLER is told about a callee turn that failed — the whole of it, in
 * one place, so the executor writes the outcome and the broker renders it
 * without either inventing wording of its own.
 *
 * It exists because the executor used to write the constant `'callee turn
 * failed'` for every failure there is, and the broker then wrapped that in
 * `CALLEE_FAILED:` — so a Manager whose Engineer had hit a session limit with
 * eleven hours left on it was handed a sentence containing no fact, and went
 * looking for the cause in the only variables it could see: it re-dispatched
 * five times in four minutes, varying the message, then the thread, then the
 * agent. Meanwhile the same turn's `error` row in the very same transcript read
 * `You've hit your session limit · resets 7:30pm (Asia/Almaty)`. Nothing was
 * hidden from the user; it was hidden only from the one participant that could
 * have acted on it.
 *
 * Pure, and its own file, for the reason every other `utils/` helper here is:
 * the two readers are in different services, and a copy in each is how the
 * wording a caller is trained on comes to differ from the wording it is sent.
 */

/**
 * Exactly the three fields of a {@link CalleeTurnOutcome} that describe a
 * failure — SPREAD onto the outcome at each construction site rather than
 * returned as a shape of its own, so a fourth fact added to the outcome cannot
 * be forgotten at one of them.
 */
export type CalleeFailureFields = Pick<
  CalleeTurnOutcome,
  'error' | 'failureClass' | 'resetsAt'
>;

/**
 * The sentence for a failure that produced no message of its own.
 *
 * A turn settles `failed` off an `error` event, which always carries a message,
 * so reaching this means geniro's own side failed instead — which is exactly
 * what `daemon_restart` is for and why it is the class here.
 */
const NO_MESSAGE =
  'the callee turn ended without reporting why — this is geniro’s own side, not the callee';

/**
 * Read a failed callee turn's message into the three facts an outcome carries.
 *
 * `diagnose` is the callee ADAPTER's `failureFrom`, passed in rather than
 * reached for: which wording means "rate limited" is a fact about one CLI, and
 * this helper must stay free of every CLI's name (`.claude/rules/agent-adapters.md`).
 *
 * The message is redacted HERE, at the one seam where a callee's own words cross
 * to a caller — a model whose provider is off this machine. Redacting at the
 * broker instead would leave the outcome itself carrying the raw text for
 * anything else that ever reads it.
 */
export function readCalleeFailure(
  message: string | null,
  diagnose: (message: string) => AgentTurnFailure,
): CalleeFailureFields {
  const said = message?.trim() ?? '';
  if (said === '') {
    return {
      error: NO_MESSAGE,
      failureClass: 'daemon_restart',
      resetsAt: null,
    };
  }
  // A diagnosis that throws must not cost the turn its bookkeeping. This runs
  // inside the executor's settle `try`, whose `finally` resolves the caller's
  // envelope either way — so a throw here would skip the callee's `node_state`
  // write and its status item, leaving the node reading `running` for the rest
  // of the run. OBSERVED while building this: the executor's own test double
  // had no `failureFrom` yet, and the only symptom was a callee stuck on
  // `running` with nothing anywhere naming a cause.
  let failure: AgentTurnFailure;
  try {
    failure = diagnose(said);
  } catch {
    failure = { class: 'crashed', resetsAt: null };
  }
  return {
    error: redactSecrets(said),
    failureClass: failure.class,
    resetsAt: failure.resetsAt,
  };
}

/**
 * A failure geniro's OWN side caused, with no CLI message to read.
 *
 * `daemon_restart` rather than `crashed`: a turn that could not be started, or
 * whose bookkeeping write failed, says nothing about the work — so the caller's
 * right move is one retry, which is the arm that class carries.
 */
export function geniroSideFailure(message: string): CalleeFailureFields {
  return {
    error: redactSecrets(message),
    failureClass: 'daemon_restart',
    resetsAt: null,
  };
}

/**
 * The `error` envelope a caller receives for a failed call.
 *
 * The CLASS is named before the sentence and inside the machine-readable prefix
 * the other envelopes already use (`DEPTH_LIMIT:`, `QUESTION_TIMEOUT:`), so an
 * agent can act on it without parsing prose — which is what a workflow role can
 * then be written against ("`rate_limited`: say when it resets and wait").
 *
 * `resetsAt` is appended only when the message does not already carry it: the
 * measured claude sentence ends `· resets 2:30pm (Asia/Almaty)`, so restating it
 * would read as two different deadlines.
 *
 * The THREAD is named for the same reason the class is, one step on. A failed
 * turn still leaves a resume handle — the executor records it before this
 * envelope is built — so the conversation, its loaded skills and whatever the
 * callee had already done survive; `thread: '<call id>'` continues it. Nothing
 * SAID so, and the cost of that silence is the whole of run `ce63c362`: three
 * QA reviews of the same ~600-line diff crashed on transport failures, and the
 * caller re-dispatched each one as a BARE call, restarting a twenty-minute
 * review from nothing three times over. Its workflow told it to retry "with the
 * same thread", which it had no way to read as an argument it must pass.
 *
 * Worded as a FACT about the conversation rather than as an instruction to
 * retry, because the four classes want four different next moves — `rate_limited`
 * is told to wait and `auth_expired` to stop — and all four want the thread when
 * they do move.
 */
export function calleeFailedEnvelopeError(
  outcome: CalleeTurnOutcome,
  callId: string,
): string {
  const reason = outcome.error ?? NO_MESSAGE;
  const cls = outcome.failureClass ?? 'crashed';
  const resets =
    outcome.resetsAt !== null && !reason.includes(outcome.resetsAt)
      ? ` — resets ${outcome.resetsAt}`
      : '';
  const thread =
    outcome.sessionId !== null
      ? ` — its conversation survives: thread: '${callId}' continues it instead of starting over`
      : '';
  return `CALLEE_FAILED[${cls}]: ${reason}${resets}${thread}`;
}
