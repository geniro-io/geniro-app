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
} from '../../../chat.types';
import { asRecord } from '../../../utils/json-util';
import type { ClaudeQuestion } from '../claude.types';

function readQuestions(input: unknown): ClaudeQuestion[] {
  const root = asRecord(input);
  if (!root || !Array.isArray(root.questions)) {
    return [];
  }
  const shapes: ClaudeQuestion[] = [];
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
 * Fold one answer into the tool input, on whichever of the CLI's two channels
 * actually fits it.
 *
 * The CLI has both, and they mean different things (documented at
 * https://code.claude.com/docs/en/agent-sdk/user-input):
 *
 * - `answers` — a map of question TEXT to the chosen value. The CLI builds the
 *   sentence the model reads, keyed per question.
 * - `response` — "a freeform reply the user typed INSTEAD of answering the
 *   structured questions". Setting it REPLACES the per-question list.
 *
 * Probe-verified on 2.1.226, which is what decides between them. Answering the
 * same two questions each way, the model received:
 *
 *   answers  → `Your questions have been answered: "Pick a colour"="Red",
 *               "Pick a size"="Small". You can now continue with these answers
 *               in mind.`
 *   response → `The user responded: Pick a colour: Red\nPick a size: Small`
 *
 * The first is unambiguous and costs nothing; the second is a blob whose
 * labelling WE hand-build and pay for out of MAX_ANSWER_LENGTH.
 *
 * So ONE question takes `answers`: a single answer maps onto a single question
 * with nothing to guess. Several questions still take `response`, because the
 * answer arrives here as ONE string — the verdict channel carries no
 * per-question structure — and splitting it apart again would mean guessing at
 * a boundary inside the user's own words. Giving that channel real structure is
 * a wire change; this is the half that can be right without one.
 */
export function withResponse(input: unknown, answer: string): unknown {
  const root = asRecord(input);
  const questions = readQuestions(input);
  if (root && questions.length === 1) {
    return { ...root, answers: { [questions[0]!.question]: answer } };
  }
  return root ? { ...root, response: answer } : { response: answer };
}
