import {
  answersByQuestion,
  cardQuestions,
} from '../../../utils/card-questions';
import { asArray, asRecord, asString } from '../../../utils/json-util';
import type { CardQuestion } from '../../adapter.types';
import {
  CURSOR_ANSWER_KEY,
  CURSOR_QUESTION_OUTCOME_ANSWERED,
  CURSOR_QUESTION_OUTCOME_SKIPPED,
} from '../cursor-acp.const';

/**
 * Reading and answering `cursor/ask_question`, cursor's vendor extension for
 * asking the USER something open-ended.
 *
 * See the block above {@link CURSOR_ASK_QUESTION_METHOD} in
 * `cursor-acp.const.ts` for where the shape came from and how far to trust it.
 * Everything here is defensive on purpose: `readCursorQuestions` returning `[]`
 * is what makes the driver decline the request rather than show a card built
 * from a payload it could not parse.
 */

/** One option of one question, as the docs name its fields. */
export interface CursorQuestionOption {
  id: string;
  label: string;
}

/** One question of a `cursor/ask_question` request. */
export interface CursorQuestion {
  id: string;
  prompt: string;
  options: CursorQuestionOption[];
  allowMultiple: boolean;
}

/**
 * The questions a `cursor/ask_question` params object carries, or `[]` when it
 * carries none this client can read.
 *
 * A question with no OPTIONS is dropped rather than kept: the only answer
 * channel the response shape offers is `selectedOptionIds`, so a free-text
 * question could be shown and then never answered.
 */
export function readCursorQuestions(params: unknown): CursorQuestion[] {
  const found: CursorQuestion[] = [];
  for (const entry of asArray(asRecord(params)?.questions)) {
    const record = asRecord(entry);
    const id = record ? asString(record.id) : null;
    const prompt = record ? asString(record.prompt) : null;
    if (record === null || id === null || id === '' || prompt === null) {
      continue;
    }
    const options: CursorQuestionOption[] = [];
    for (const option of asArray(record.options)) {
      const optionRecord = asRecord(option);
      const optionId = optionRecord ? asString(optionRecord.id) : null;
      if (optionId === null || optionId === '') {
        continue;
      }
      // The id when the agent gave no label: an unlabelled row is unpickable,
      // and the id is at least something the user can choose between.
      options.push({
        id: optionId,
        label: asString(optionRecord?.label) || optionId,
      });
    }
    if (options.length === 0) {
      continue;
    }
    found.push({
      id,
      prompt,
      options,
      allowMultiple: record.allowMultiple === true,
    });
  }
  return found;
}

/**
 * A `cursor/ask_question` params object as the user's question card. It has no
 * per-question title — the request-level `title` names the whole ask, and
 * repeating it on every tab would label them identically — and its options
 * carry neither a description nor a preview.
 */
export function cursorCardQuestions(params: unknown): CardQuestion[] {
  return cardsOf(readCursorQuestions(params));
}

/**
 * The card of questions already read. The ONE projection — the row the adapter
 * stamps and {@link encodeCursorQuestionReply}'s split of the submission both
 * go through it, so a reply is read back against the very cards the user was
 * shown.
 */
function cardsOf(questions: readonly CursorQuestion[]): CardQuestion[] {
  return cardQuestions(
    questions.map((question) => ({
      question: question.prompt,
      header: null,
      multiSelect: question.allowMultiple,
      options: question.options.map((option) => ({
        label: option.label,
        description: null,
        preview: null,
      })),
    })),
  );
}

/** Stash the card's free-text answer for {@link encodeCursorQuestionReply}. */
export function withCursorAnswer(params: unknown, answer: string): unknown {
  return { ...(asRecord(params) ?? {}), [CURSOR_ANSWER_KEY]: answer };
}

/**
 * The option a free-text answer names, matched case-insensitively against the
 * labels the user was actually shown, then against the raw option ids.
 *
 * Label first because the label is what the card offered — an answer echoing
 * one is the ordinary case. Matching the id too costs nothing and covers a
 * caller agent answering with what it read off the envelope.
 */
function matchOption(
  question: CursorQuestion,
  answer: string,
): CursorQuestionOption | null {
  const wanted = answer.trim().toLowerCase();
  if (wanted === '') {
    return null;
  }
  return (
    question.options.find((option) => option.label.toLowerCase() === wanted) ??
    question.options.find((option) => option.id.toLowerCase() === wanted) ??
    null
  );
}

/** How the card joins several picks into the one answer string it submits. */
const ANSWER_SEPARATOR = ',';

/**
 * Every option a verdict's answer names, or null when it names something that
 * is not on offer.
 *
 * The whole string is tried FIRST, so a label containing a comma still matches
 * itself. Only then, and only for a question the agent marked
 * `allowMultiple`, is the answer split the way the card joined it. Keeping the
 * split off single-select questions is deliberate: "Red, Blue" answered to a
 * pick-one question is not a pick of Red, and silently reading it as one would
 * report a choice the user did not make.
 *
 * Answering multi-select at all is a capability of THIS channel specifically.
 * Cursor's own `-32601` fallback filters `allowMultiple` questions out and
 * never asks them, because a permission request can carry only one selected
 * option — so before this channel there was no way to answer one.
 */
function matchOptions(
  question: CursorQuestion,
  answer: string,
): CursorQuestionOption[] | null {
  const whole = matchOption(question, answer);
  if (whole !== null) {
    return [whole];
  }
  if (!question.allowMultiple) {
    return null;
  }
  const parts = answer
    .split(ANSWER_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length < 2) {
    return null;
  }
  const picked: CursorQuestionOption[] = [];
  for (const part of parts) {
    const option = matchOption(question, part);
    // All or nothing: a partial read would drop a choice the user made while
    // reporting the rest as their complete answer.
    if (option === null) {
      return null;
    }
    if (!picked.some((already) => already.id === option.id)) {
      picked.push(option);
    }
  }
  return picked;
}

/**
 * What the user answered each question, read out of the ONE string the card
 * submits — by position in the cards, which is what `answersByQuestion` keys on.
 *
 * That position is a question's own only while every question reached the card:
 * `cardQuestions` drops one whose prompt is empty, so when the counts differ no
 * index means the same question on both sides, and every question is offered
 * the whole answer instead — what a lone question is always given.
 */
function answersOf(
  answer: string,
  questions: readonly CursorQuestion[],
): (string | null)[] {
  const cards = cardsOf(questions);
  return cards.length === questions.length
    ? answersByQuestion(answer, cards)
    : questions.map(() => answer);
}

/**
 * The `CursorAskQuestionResponse` for a card verdict.
 *
 * Three outcomes, and which one is sent turns on what the user actually did:
 *
 * - `answered` when the verdict allows AND each question's own part of the text
 *   names an option of it. Only then can the agent be told a real selection.
 * - `skipped`, carrying the WHOLE answer as its `reason`, when the verdict
 *   allows but some question's part is missing or matches no option. That is
 *   the honest arm: the protocol has no channel for free text, so inventing a
 *   `selectedOptionIds` from an unmatched string would answer the agent with a
 *   choice the user did not make. The `reason` is what still gets their words
 *   across.
 * - `skipped` with no reason when the verdict denies. `cancelled` is
 *   deliberately unused — it reads as "the client aborted", where the truth is
 *   that the user was asked and declined.
 */
export function encodeCursorQuestionReply(
  params: unknown,
  allow: boolean,
  updatedInput: unknown,
): unknown {
  if (!allow) {
    return { outcome: { outcome: CURSOR_QUESTION_OUTCOME_SKIPPED } };
  }
  // `updatedInput` is `withCursorAnswer`'s output when the card carried an
  // answer, and the untouched params when it did not.
  const source = asRecord(updatedInput) ?? asRecord(params);
  const answer = asString(source?.[CURSOR_ANSWER_KEY]);
  const questions = readCursorQuestions(source ?? params);
  if (answer === null || questions.length === 0) {
    return { outcome: { outcome: CURSOR_QUESTION_OUTCOME_SKIPPED } };
  }
  const own = answersOf(answer, questions);
  const answers: { questionId: string; selectedOptionIds: string[] }[] = [];
  for (const [index, question] of questions.entries()) {
    const value = own[index] ?? null;
    const options = value === null ? null : matchOptions(question, value);
    if (options === null) {
      return {
        outcome: { outcome: CURSOR_QUESTION_OUTCOME_SKIPPED, reason: answer },
      };
    }
    answers.push({
      questionId: question.id,
      selectedOptionIds: options.map((option) => option.id),
    });
  }
  return { outcome: { outcome: CURSOR_QUESTION_OUTCOME_ANSWERED, answers } };
}
