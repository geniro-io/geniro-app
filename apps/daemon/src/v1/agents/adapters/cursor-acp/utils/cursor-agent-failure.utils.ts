import {
  CURSOR_AGENT_FAILURE_ACTION_SENTENCES,
  CURSOR_AGENT_FAILURE_ERROR_KINDS,
  CURSOR_AGENT_FAILURE_PREFIX,
  CURSOR_AGENT_FAILURE_UNAUTHENTICATED,
} from '../cursor-acp.const';

/**
 * Whether one `agent_message_chunk` is this CLI reporting its OWN failure
 * rather than the agent talking — and, when it is, the sentence it reported.
 *
 * REPORTED with a screenshot: `Error: RetriableError: [unavailable] PING timed
 * out` sitting in the transcript as ordinary assistant prose, under a footer
 * reading `✓ done · 1m 14s`. The turn had failed, said so, and was recorded as
 * a success.
 *
 * ## Why there is nothing on the protocol to read
 *
 * This adapter carried the note that a cursor network failure "is reported as
 * ordinary assistant TEXT under `stopReason: end_turn`" and that telling it
 * apart "would mean matching that vendor's prose, which is why nothing here
 * does". The first half is confirmed; the second was a judgement made without
 * reading the CLI, and reading it changes the answer. From the shipped
 * 2026.08.11-e8db854 bundle, `2996.index.js` — its whole ACP layer — the run is
 * wrapped in ONE catch, and every arm of it writes a message chunk:
 *
 *     catch(e){
 *       if (e instanceof a.cc || t.canceled) return;            // CancelledError
 *       if (e instanceof a.ao) {                                // ActionRequiredError
 *         const t = {login:"Please sign in to continue",
 *                    upgrade:"Upgrade your plan to continue",
 *                    payment:"Add a payment method to continue",
 *                    config:"Check your settings to continue"}[e.action] ?? e.message;
 *         return void (yield this.sendAgentMessageChunk(`\n\n${t}`));
 *       }
 *       if (e instanceof m.T && e.code === C.C.Unauthenticated)
 *         return void (yield this.sendAgentMessageChunk(
 *           "\n\nError: [unauthenticated] Backend rejected authentication. …"));
 *       yield this.sendAgentMessageChunk(`\n\nError: ${String(e)}`);
 *     }
 *
 * and `handlePrompt` around it returns `{stopReason:"end_turn"}` on every path
 * that is not a cancel. So the failure is DELIBERATELY flattened into the
 * conversation before the protocol sees it: there is no field to read, no
 * status to check, and no version of this that a stricter ACP client fixes.
 *
 * ## What is matched, and why it is not "the vendor's prose"
 *
 * Two anchors, both structural rather than editorial:
 *
 * - The `\n\nError: ` prefix is a LITERAL in that catch block, written by the
 *   CLI and not by any model.
 * - What follows it is `String(e)` of the CLI's own error class, whose `name`
 *   is a `get kind()` getter returning one of four fixed strings —
 *   `RetriableError`, `NonRetriableError`, `ActionRequiredError`,
 *   `CancelledError` (`index.js`: `class R extends B{get kind(){return
 *   "RetriableError"}}` and its three siblings). So the second anchor is a
 *   CLASS NAME, which is what makes `Error: RetriableError: …` different from
 *   an agent that happens to write the word "error".
 *
 * Requiring BOTH is what keeps this from firing on an answer ABOUT an error —
 * the commonest thing a coding agent writes. A model quoting a stack trace
 * writes it inside its own sentence or a code fence, not as a chunk that opens
 * with the CLI's blank-line prefix and one of its four class names.
 *
 * The `unauthenticated` arm is matched on its own fixed opening, since it
 * carries no class name at all, and the four `ActionRequiredError` sentences on
 * theirs, since that arm replaces the class name with a sentence. Its fallback
 * (`e.message`, for an action the CLI does not have a sentence for) is
 * deliberately NOT matched: it is a bare unanchored string, and guessing at it
 * would put the agent's own words in the failure chrome.
 *
 * Returns the message with the CLI's leading blank lines trimmed, or null when
 * the chunk is the agent talking — which is every chunk on a healthy turn.
 */
export function readCursorAgentFailure(text: string): string | null {
  const body = text.replace(/^\s+/, '');
  if (body === '') {
    return null;
  }
  // EXACTLY one of the four, not merely opening with one: this arm sends
  // `\n\n${sentence}` and nothing else, while an agent that happens to begin a
  // paragraph with those words ("Please sign in to continue is what the page
  // says") is talking. These four are ordinary English, so unlike the anchors
  // below they carry no marker of their own — the whole-chunk match is what
  // stands in for one. Caught by this file's own spec.
  if (CURSOR_AGENT_FAILURE_ACTION_SENTENCES.includes(body.trimEnd())) {
    return body.trimEnd();
  }
  if (!body.startsWith(CURSOR_AGENT_FAILURE_PREFIX)) {
    return null;
  }
  const rest = body.slice(CURSOR_AGENT_FAILURE_PREFIX.length);
  if (rest.startsWith(CURSOR_AGENT_FAILURE_UNAUTHENTICATED)) {
    return body;
  }
  return CURSOR_AGENT_FAILURE_ERROR_KINDS.some((kind) =>
    rest.startsWith(`${kind}:`),
  )
    ? body
    : null;
}
