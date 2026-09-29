import type {
  AdapterQuestion,
  CardQuestion,
  CardQuestionOption,
} from '../adapters/adapter.types';
import { MAX_ANSWER_LENGTH, MAX_QUESTION_HEADER_LENGTH } from '../chat.types';

/** One question read out of a payload, before the card's limits apply. */
export interface CardQuestionDraft {
  question: string | null;
  header: string | null;
  multiSelect: boolean;
  /** Whether the CLI marked the answer a secret — see {@link CardQuestion.secret}. */
  secret?: boolean;
  options: readonly {
    label: string | null;
    description: string | null;
    preview: string | null;
  }[];
}

/**
 * The card's limits, applied once for every source of a question: a question
 * with no text is dropped, an option label is kept only when non-empty and
 * within MAX_ANSWER_LENGTH (the answer channel refuses a longer one), a header
 * only when non-empty and within MAX_QUESTION_HEADER_LENGTH, a blank
 * description or preview is absent, and `secret` is written only when true.
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/approval-card.tsx `readQuestions`
 * applies the same limits to what it is handed.
 */
export function cardQuestions(
  drafts: readonly CardQuestionDraft[],
): CardQuestion[] {
  const cards: CardQuestion[] = [];
  for (const draft of drafts) {
    if (!draft.question) {
      continue;
    }
    const options: CardQuestionOption[] = [];
    for (const option of draft.options) {
      if (!option.label || option.label.length > MAX_ANSWER_LENGTH) {
        continue;
      }
      options.push({
        label: option.label,
        description: present(option.description),
        preview: present(option.preview),
      });
    }
    cards.push({
      question: draft.question,
      header:
        draft.header && draft.header.length <= MAX_QUESTION_HEADER_LENGTH
          ? draft.header
          : null,
      options,
      multiSelect: draft.multiSelect,
      ...(draft.secret === true ? { secret: true as const } : {}),
    });
  }
  return cards;
}

/** Whether any question on a card asks for a secret. */
export function asksForSecret(
  cards: readonly CardQuestion[] | undefined,
): boolean {
  return cards?.some((card) => card.secret === true) ?? false;
}

/**
 * How much of a question's text labels its line in a multi-question
 * submission — see {@link answersByQuestion}.
 */
export const MAX_ANSWER_LABEL_LENGTH = 80;

/**
 * What the user answered each question of a card, read back out of the ONE
 * string the card submits: by position in `cards`, the whole submission for a
 * lone question, and for several each question's own value — or null where its
 * entry cannot be found. A value that ran onto the lines after its own (an
 * image note rides a line of its own) keeps them.
 *
 * An entry is found by where it STARTS — its label at the start of the
 * submission or of a line — never by splitting into lines first: the label is
 * the question's own text, which may hold a line break of its own.
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/approval-card.tsx `combinedAnswer`
 * (with `answerLabel`) writes that submission — a drift fixed there must be
 * mirrored here, and vice versa. Mirrored rules: several questions only; one
 * `<label>: <value>` entry per question, in card order; a label is the
 * question's text, cut to MAX_ANSWER_LABEL_LENGTH with a trailing `…`; entries
 * joined by `\n`.
 */
export function answersByQuestion(
  answer: string,
  cards: readonly CardQuestion[],
): (string | null)[] {
  if (cards.length < 2) {
    return cards.map(() => answer);
  }
  const prefixes = cards.map((card) => `${answerLabelOf(card)}: `);
  const values: (string | null)[] = cards.map(() => null);
  let current = -1;
  let valueStart = 0;
  let lineStart: number | null = 0;
  while (lineStart !== null) {
    const at = lineStart;
    // Only a LATER question can open next, so a value that happens to begin
    // with an earlier question's label stays that question's continuation.
    const start = prefixes.findIndex(
      (prefix, index) => index > current && answer.startsWith(prefix, at),
    );
    const prefix = prefixes[start];
    let scanFrom = at;
    if (prefix !== undefined) {
      if (current !== -1) {
        values[current] = answer.slice(valueStart, at - 1);
      }
      current = start;
      valueStart = at + prefix.length;
      // The next entry starts after this label, however many lines it spans.
      scanFrom = valueStart;
    }
    const newline = answer.indexOf('\n', scanFrom);
    lineStart = newline === -1 ? null : newline + 1;
  }
  if (current !== -1) {
    values[current] = answer.slice(valueStart);
  }
  return values;
}

/**
 * The values a card's answer holds for its SECRET questions: the whole
 * submission, and each secret question's own value as well — an agent that
 * later repeats the secret repeats that value, never the whole submission.
 */
export function secretAnswerParts(
  answer: string,
  cards: readonly CardQuestion[],
): string[] {
  const own = answersByQuestion(answer, cards);
  const parts = [answer];
  cards.forEach((card, index) => {
    const value = own[index];
    if (card.secret === true && value && !parts.includes(value)) {
      parts.push(value);
    }
  });
  return parts;
}

function answerLabelOf(card: CardQuestion): string {
  return card.question.length <= MAX_ANSWER_LABEL_LENGTH
    ? card.question
    : `${card.question.slice(0, MAX_ANSWER_LABEL_LENGTH - 1)}…`;
}

/**
 * A card as the CALLER's envelope (`AgentAdapter.questionFrom`): one line per
 * question and every option label flat across them — built FROM the card, so a
 * calling agent is offered exactly what the user would have been shown, under
 * the same limits. Null for a card with no question.
 *
 * Each line carries its header and, when set, the multi-pick affordance: the
 * envelope's options are flat across questions, so without the header a caller
 * handed two questions cannot tell which option belongs to which, and without
 * the note it cannot learn that more than one label is wanted. `lead` opens the
 * text, for a CLI whose request names the whole ask.
 */
export function adapterQuestionOf(
  cards: readonly CardQuestion[],
  lead: string | null = null,
): AdapterQuestion | null {
  if (cards.length === 0) {
    return null;
  }
  const lines = cards.map((card) => {
    const head = card.header === null ? '' : `[${card.header}] `;
    const multi = card.multiSelect ? ' (pick one or more)' : '';
    return `${head}${card.question}${multi}`;
  });
  return {
    text: (lead ? [lead, ...lines] : lines).join('\n'),
    options: cards.flatMap((card) => card.options.map(({ label }) => label)),
  };
}

function present(text: string | null): string | null {
  return text !== null && text.trim().length > 0 ? text : null;
}
