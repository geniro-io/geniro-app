/**
 * Projections over claude's AskUserQuestion tool input (the probe-verified
 * shape:
 * `{ questions: [{ question, header, options: [{ label, … }], multiSelect }] }`)
 * for the M4 Q&A bridge. Defensive throughout — a malformed or
 * version-drifted payload degrades to empty projections, never a throw
 * (the raw payload still reaches the transcript row untouched).
 *
 * TWIN PARSER: the renderer's question card re-implements this parse over the
 * same wire shape (apps/ui/src/renderer/chats/approval-card.tsx
 * `readQuestions`) because no daemon↔renderer shared package exists — a shape
 * drift fixed here must be mirrored there, and vice versa. Mirrored rules:
 * option labels are kept only when non-empty and ≤ MAX_ANSWER_LENGTH (an
 * oversized label would offer an answer the answer channel itself rejects);
 * `header` is kept only when non-empty and ≤ MAX_QUESTION_HEADER_LENGTH, and
 * `multiSelect` is true only when the payload says so literally (a truthy
 * string would let one side offer multi-pick while the other offers one).
 */

import {
  MAX_ANSWER_LENGTH,
  MAX_QUESTION_HEADER_LENGTH,
} from '../../chat.types';

interface QuestionShape {
  question: string;
  /** The CLI's short tab title for this question; null when it sent none. */
  header: string | null;
  options: string[];
  multiSelect: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readQuestions(input: unknown): QuestionShape[] {
  const root = asRecord(input);
  if (!root || !Array.isArray(root.questions)) {
    return [];
  }
  const shapes: QuestionShape[] = [];
  for (const entry of root.questions) {
    const q = asRecord(entry);
    const text = typeof q?.question === 'string' ? q.question : null;
    if (!q || !text) {
      continue;
    }
    const options = Array.isArray(q.options)
      ? q.options
          .map((o) => asRecord(o)?.label)
          .filter(
            (label): label is string =>
              typeof label === 'string' &&
              label.length > 0 &&
              label.length <= MAX_ANSWER_LENGTH,
          )
      : [];
    const header =
      typeof q.header === 'string' &&
      q.header.length > 0 &&
      q.header.length <= MAX_QUESTION_HEADER_LENGTH
        ? q.header
        : null;
    shapes.push({
      question: text,
      header,
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return shapes;
}

/**
 * The question text for the caller's envelope (multi-question joins lines).
 *
 * Each line carries its `header` and, when set, the multi-pick affordance: the
 * envelope's `options` are FLAT across questions, so without the header a
 * caller receiving two questions cannot tell which option belongs to which —
 * and without the multi-pick note it has no way to learn that more than one
 * label is wanted.
 */
export function questionTextOf(input: unknown): string {
  return readQuestions(input)
    .map((q) => {
      const head = q.header === null ? '' : `[${q.header}] `;
      const multi = q.multiSelect ? ' (pick one or more)' : '';
      return `${head}${q.question}${multi}`;
    })
    .join('\n');
}

/** Every option label the callee offered, across all questions. */
export function optionLabelsOf(input: unknown): string[] {
  return readQuestions(input).flatMap((q) => q.options);
}

/**
 * The caller's (or user's) free-text answer folded into the tool input as the
 * `response` field — claude's AskUserQuestion surfaces it to the model as
 * "The user responded: <text>" (probe-verified on 2.1.202).
 */
export function withResponse(input: unknown, answer: string): unknown {
  const root = asRecord(input);
  return root ? { ...root, response: answer } : { response: answer };
}
