/**
 * Projections over claude's AskUserQuestion tool input (the probe-verified
 * shape:
 * `{ questions: [{ question, header, options: [{ label, … }], multiSelect }] }`)
 * for the M4 Q&A bridge. Defensive throughout — a malformed or
 * version-drifted payload degrades to empty projections, never a throw
 * (the raw payload still reaches the transcript row untouched).
 *
 * The payload is read ONCE, into the card ({@link claudeCardQuestions}), and
 * everything else is built from that: the renderer draws it, and the caller's
 * envelope is `adapterQuestionOf` over it, so a calling agent can never be
 * offered a label or a header the card would not show.
 */

import { cardQuestions } from '../../../utils/card-questions';
import { asArray, asRecord, asString } from '../../../utils/json-util';
import type { CardQuestion } from '../../adapter.types';

/**
 * An AskUserQuestion input as the user's question card — including each
 * option's `description` and `preview`, which only the card shows.
 */
export function claudeCardQuestions(input: unknown): CardQuestion[] {
  return cardQuestions(
    asArray(asRecord(input)?.questions).map((entry) => {
      const question = asRecord(entry);
      return {
        question: asString(question?.question),
        header: asString(question?.header),
        multiSelect: question?.multiSelect === true,
        options: asArray(question?.options).map((value) => {
          const option = asRecord(value);
          return {
            label: asString(option?.label),
            description: asString(option?.description),
            preview: asString(option?.preview),
          };
        }),
      };
    }),
  );
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
  const questions = claudeCardQuestions(input);
  if (root && questions.length === 1) {
    return { ...root, answers: { [questions[0]!.question]: answer } };
  }
  return root ? { ...root, response: answer } : { response: answer };
}
