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
  return [
    'Name this conversation in 3 to 6 words, as a title for a list of chats.',
    'Say what the work IS — the task, the subject, the thing being changed.',
    'Answer with the title alone: no quotes, no trailing full stop, no',
    'preamble, and nothing about being asked for a title.',
    // The one instruction that is not about FORMAT, and it is here because the
    // opening is routinely a bare link or a slash command: measured on
    // 2.1.237, that prompt without this line answers "I need to see the Slack
    // thread to understand what work you're asking about…" — prose, on a turn
    // whose whole output is used as a sidebar row.
    'You cannot open links and do not need to: name the conversation from the',
    'words in front of you. Never ask for anything.',
    '',
    ...section('THE USER OPENED WITH', input.opening),
    ...section('THE AGENT ANSWERED', input.reply),
    // Only present once the conversation has moved on — see
    // `AgentTitleInput.latest`.
    ...section('LATELY THEY HAVE BEEN DISCUSSING', input.latest),
  ].join('\n');
}

/** One labelled block of the exchange, or nothing when there is no text. */
function section(label: string, text: string | null): string[] {
  return text === null || text.trim() === ''
    ? []
    : [`${label}:`, excerpt(text), ''];
}

/**
 * The title an agent actually answered with, or null when it answered
 * something that is not a title.
 *
 * This is the ACCEPTANCE half of the prompt above and lives beside it for the
 * same reason: the two are one contract, and an adapter that asks the shared
 * question must not invent its own idea of what counts as an answer.
 *
 * It exists because a model asked to name a conversation it cannot name does
 * not fail — it explains itself, at length, and the explanation was written
 * into the sidebar. Reproduced through this daemon on 2.1.237: a chat came out
 * titled `I don't have enough information to name this work yet. You'…`, which
 * is strictly worse than the opening line it replaced. So a non-title is a
 * REFUSAL to be declined, and the caller keeps the derived title.
 *
 * The two rejections are structural rather than a phrase list, because the
 * wording belongs to the model:
 *
 * - **more than one sentence** — a title has no sentence break in it, and every
 *   refusal observed has one. A single trailing full stop is not that: the
 *   prompt bans it and a model still adds it, so it is STRIPPED below.
 * - **too many words** — the ask is 3 to 6, so twice the ceiling is generous
 *   and still catches a refusal that fits in one sentence.
 */
export function readTitleAnswer(raw: string): string | null {
  const title = unwrapTitle(raw.trim());
  if (title === '') {
    return null;
  }
  if (/[.!?](\s|$)/.test(title.slice(0, -1)) || title.includes('\n')) {
    return null;
  }
  return title.split(/\s+/).length > TITLE_MAX_WORDS ? null : title;
}

/**
 * The ceiling on an answer's word count.
 *
 * Twice what the prompt asks for. A real title runs 3 to 6 words (`Resolving
 * TickTick Issues with Confirmation` is five), so the slack is entirely for a
 * model that padded — not for prose, which this is meant to reject.
 */
export const TITLE_MAX_WORDS = 12;

/**
 * The title itself, with the packaging a model adds when it ignores the ask.
 *
 * Only the two forms that are unambiguously packaging: a whole answer inside
 * matching quotes, and a trailing full stop. Neither can be part of a title a
 * reader wanted — a name ending in `.` is not one, and a fully-quoted answer is
 * the model quoting itself — while anything more (stripping a leading `Title:`,
 * say) starts matching prose, which {@link readTitleAnswer} declines outright.
 */
function unwrapTitle(text: string): string {
  const dequoted =
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith('\u201c') && text.endsWith('\u201d')) ||
    (text.startsWith("'") && text.endsWith("'"))
      ? text.slice(1, -1).trim()
      : text;
  return dequoted.endsWith('.') ? dequoted.slice(0, -1).trim() : dequoted;
}

/** One side of the exchange, cut to the budget at a character boundary. */
function excerpt(text: string): string {
  const trimmed = text.trim();
  return [...trimmed].length <= TITLE_EXCERPT_MAX_CHARS
    ? trimmed
    : `${[...trimmed].slice(0, TITLE_EXCERPT_MAX_CHARS).join('')}…`;
}
