import type { AgentTitleInput } from '../adapter.types';

/**
 * What to ask an agent when the conversation needs a name.
 *
 * Agent-agnostic on purpose: the wording is where the quality of every
 * generated title lives, so a second CLI implementing `generateTitle` composes
 * this rather than writing a prompt of its own that would drift from it. What
 * stays with each adapter is HOW the question is put — argv, transport, and
 * reading the answer back.
 *
 * The excerpt is bounded on both halves. This is billed per chat, and an
 * opening message can be a whole specification: the first paragraphs are what
 * name a conversation, and the rest is detail nobody titles by.
 */

/** How much of each side of the exchange the prompt quotes. */
export const TITLE_EXCERPT_MAX_CHARS = 1_200;

/**
 * The instruction, then the exchange under labelled headings.
 *
 * The rules are stated as rules because the answer is used VERBATIM as a
 * sidebar row: an agent left to its own devices offers `Here's a title:
 * "Fix the worktree conflicts"`, and stripping that back out means matching
 * prose. The ban on quotes and trailing punctuation is the same defence.
 */
export function titlePrompt(input: AgentTitleInput): string {
  const reply =
    input.reply === null || input.reply.trim() === ''
      ? ''
      : `\n\nTHE AGENT ANSWERED:\n${excerpt(input.reply)}`;
  return [
    'Name this conversation in 3 to 6 words, as a title for a list of chats.',
    'Say what the work IS — the task, the subject, the thing being changed.',
    'Answer with the title alone: no quotes, no trailing full stop, no',
    'preamble, and nothing about being asked for a title.',
    '',
    `THE USER OPENED WITH:\n${excerpt(input.opening)}${reply}`,
  ].join('\n');
}

/** One side of the exchange, cut to the budget at a character boundary. */
function excerpt(text: string): string {
  const trimmed = text.trim();
  return [...trimmed].length <= TITLE_EXCERPT_MAX_CHARS
    ? trimmed
    : `${[...trimmed].slice(0, TITLE_EXCERPT_MAX_CHARS).join('')}…`;
}
