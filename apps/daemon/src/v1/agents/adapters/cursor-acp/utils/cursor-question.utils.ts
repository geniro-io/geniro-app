import { asArray, asRecord, asString } from '../../../utils/json-util';
import type { AdapterQuestion } from '../../adapter.types';
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
 * The card projection: the question text, and every option label flat across
 * questions — the same contract claude's `questionFrom` obeys, so the renderer
 * and a caller envelope need no per-CLI branch.
 *
 * The request's own `title` leads when it has one, since a multi-question ask
 * has no single prompt to show.
 */
export function cursorAdapterQuestion(params: unknown): AdapterQuestion | null {
  const questions = readCursorQuestions(params);
  if (questions.length === 0) {
    return null;
  }
  const title = asString(asRecord(params)?.title);
  const prompts = questions.map((question) => question.prompt);
  return {
    text: title || prompts.join('\n\n'),
    options: questions.flatMap((question) =>
      question.options.map((option) => option.label),
    ),
  };
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
 * How much of a question's text labels its line in a multi-question answer.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/approval-card.tsx` —
 * `MAX_ANSWER_LABEL_LENGTH` and `answerLabel`, which COMPOSE the lines this
 * reads. The card cuts a long question to 79 characters plus `…` so the label
 * cannot spend the answer's length budget; a change to that rule there must be
 * mirrored here, or every long question's line stops matching and its answer
 * is sent back as skipped.
 */
const MAX_ANSWER_LABEL_LENGTH = 80;

function answerLabel(prompt: string): string {
  return prompt.length <= MAX_ANSWER_LABEL_LENGTH
    ? prompt
    : `${prompt.slice(0, MAX_ANSWER_LABEL_LENGTH - 1)}…`;
}

/**
 * One answer per question, read out of the card's MULTI-question submission,
 * or null when the answer is not in that shape.
 *
 * TWIN PARSER: the card's `combinedAnswer` — one `<question>: <answer>` line
 * per question, joined by newlines — is the only channel several answers have,
 * since the verdict carries one string. Matched by LABEL rather than by line
 * position, each line used once, so two questions sharing a prompt still take
 * one line each.
 *
 * It exists because the whole string matches no question's options: a card
 * answering "Colour?" with Red and "Size?" with Small submits two labelled
 * lines, which match no option of either. Matched as one string, every
 * multi-question answer the user gave would be sent back as `skipped`.
 */
function labelledAnswers(
  questions: readonly CursorQuestion[],
  answer: string,
): string[] | null {
  const lines = answer.split('\n');
  const used = new Set<number>();
  const answers: string[] = [];
  for (const question of questions) {
    const prefix = `${answerLabel(question.prompt)}: `;
    const at = lines.findIndex(
      (line, index) => !used.has(index) && line.startsWith(prefix),
    );
    if (at === -1) {
      return null;
    }
    used.add(at);
    answers.push(lines[at]!.slice(prefix.length));
  }
  return answers;
}

/**
 * The `CursorAskQuestionResponse` for a card verdict.
 *
 * Three outcomes, and which one is sent turns on what the user actually did:
 *
 * - `answered` when the verdict allows AND the text names an option of every
 *   question — each question read off its own labelled line when the card
 *   asked several (see {@link labelledAnswers}). Only then can the agent be
 *   told a real selection.
 * - `skipped`, carrying the answer as its `reason`, when the verdict allows
 *   but the text matches no option. That is the honest arm: the protocol has
 *   no channel for free text, so inventing a `selectedOptionIds` from an
 *   unmatched string would answer the agent with a choice the user did not
 *   make. The `reason` is what still gets their words across.
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
  // Several questions answer through the card's labelled lines. A string not
  // in that shape — a caller agent's own reply, a lone question — is matched
  // whole against each question, as it always was.
  const perQuestion =
    (questions.length > 1 ? labelledAnswers(questions, answer) : null) ??
    questions.map(() => answer);
  const answers: { questionId: string; selectedOptionIds: string[] }[] = [];
  for (const [index, question] of questions.entries()) {
    const options = matchOptions(question, perQuestion[index] ?? answer);
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
