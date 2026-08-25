/**
 * Carrying a compacted conversation into the session that replaces it.
 *
 * Only a CLI whose compaction geniro performs itself passes through here
 * (`AgentGeniroCommand.replacesSession`). That compaction works by DROPPING the
 * agent's own session, so the next turn opens on an agent that knows nothing —
 * and the summary the compaction produced is the only thing standing between
 * the user and a conversation that has forgotten itself. This is where it is
 * put back.
 *
 * A CLI that compacts its own history never reaches this: it rewrote its
 * context in place and its next turn resumes the same session.
 */

/**
 * The tag the summary is wrapped in.
 *
 * Wrapped rather than pasted, because the two halves are not the same kind of
 * text: the summary is a RECORD of what was said, the message under it is
 * somebody speaking now. Run together, the first turn after a compaction reads
 * as one enormous user message, and an agent answering the summary rather than
 * the question is the predictable result.
 */
const CARRIED_TAG = 'compacted-conversation';

/** The sentence that says what the block is and what to do with it. */
const CARRIED_NOTE =
  'This conversation was compacted. The block below is a summary of ' +
  'everything said before this point — treat it as your own memory of the ' +
  'conversation so far, not as something the user just wrote. Answer the ' +
  'message that follows it.';

/**
 * One turn's prompt with the summary it is owed prepended, or the prompt
 * unchanged when nothing is owed.
 *
 * A blank summary counts as nothing owed: a compaction that produced no words
 * has nothing to carry, and an empty block would tell the agent its memory of
 * the conversation is empty — which is worse than saying nothing, because it is
 * an assertion.
 */
export function withCarriedContext(
  carried: string | null,
  prompt: string,
): string {
  const summary = carried?.trim() ?? '';
  if (summary === '') {
    return prompt;
  }
  return [
    CARRIED_NOTE,
    `<${CARRIED_TAG}>`,
    summary,
    `</${CARRIED_TAG}>`,
    '',
    prompt,
  ].join('\n');
}
