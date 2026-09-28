import { describe, expect, it } from 'vitest';

import type { CardQuestion } from '../adapters/adapter.types';
import { MAX_ANSWER_LENGTH, MAX_QUESTION_HEADER_LENGTH } from '../chat.types';
import {
  adapterQuestionOf,
  answersByQuestion,
  asksForSecret,
  cardQuestions,
  MAX_ANSWER_LABEL_LENGTH,
  secretAnswerParts,
} from './card-questions';

const option = (label: string | null) => ({
  label,
  description: null,
  preview: null,
});

describe('cardQuestions', () => {
  it('drops a question with no text', () => {
    expect(
      cardQuestions([
        { question: null, header: null, multiSelect: false, options: [] },
        { question: '', header: null, multiSelect: false, options: [] },
      ]),
    ).toEqual([]);
  });

  it('keeps only the labels the answer channel can carry', () => {
    const [card] = cardQuestions([
      {
        question: 'Which?',
        header: null,
        multiSelect: false,
        options: [
          option(null),
          option(''),
          option('x'.repeat(MAX_ANSWER_LENGTH + 1)),
          option('Fine'),
        ],
      },
    ]);
    expect(card?.options.map((kept) => kept.label)).toEqual(['Fine']);
  });

  it('drops a header that is empty or too long for a tab title', () => {
    const cards = cardQuestions([
      {
        question: 'A',
        header: 'x'.repeat(MAX_QUESTION_HEADER_LENGTH + 1),
        multiSelect: false,
        options: [],
      },
      {
        question: 'B',
        header: 'x'.repeat(MAX_QUESTION_HEADER_LENGTH),
        multiSelect: true,
        options: [],
      },
      { question: 'C', header: '', multiSelect: false, options: [] },
    ]);
    expect(cards.map((card) => card.header)).toEqual([
      null,
      'x'.repeat(MAX_QUESTION_HEADER_LENGTH),
      null,
    ]);
    expect(cards.map((card) => card.multiSelect)).toEqual([false, true, false]);
  });

  it('reads a blank description or preview as absent', () => {
    const [card] = cardQuestions([
      {
        question: 'Which?',
        header: null,
        multiSelect: false,
        options: [
          { label: 'A', description: '  ', preview: '\n' },
          { label: 'B', description: 'kept', preview: '# kept' },
        ],
      },
    ]);
    expect(card?.options).toEqual([
      { label: 'A', description: null, preview: null },
      { label: 'B', description: 'kept', preview: '# kept' },
    ]);
  });

  it('writes `secret` only on a question marked secret', () => {
    const cards = cardQuestions([
      { question: 'Name?', header: null, multiSelect: false, options: [] },
      {
        question: 'Password?',
        header: null,
        multiSelect: false,
        secret: true,
        options: [],
      },
    ]);

    expect(cards[0]).not.toHaveProperty('secret');
    expect(cards[1]?.secret).toBe(true);
    expect(asksForSecret(cards)).toBe(true);
    expect(asksForSecret(cards.slice(0, 1))).toBe(false);
    expect(asksForSecret(undefined)).toBe(false);
  });
});

describe('adapterQuestionOf', () => {
  const card = (over: Partial<CardQuestion>): CardQuestion => ({
    question: 'Which color?',
    header: null,
    multiSelect: false,
    options: [],
    ...over,
  });
  const option = (label: string) => ({
    label,
    description: null,
    preview: null,
  });

  it('answers null for a card holding no question', () => {
    expect(adapterQuestionOf([])).toBeNull();
    expect(adapterQuestionOf([], 'The whole ask')).toBeNull();
  });

  it('writes one line per question — its header, and whether more than one label is wanted', () => {
    expect(
      adapterQuestionOf([
        card({ header: 'Color', options: [option('Red'), option('Blue')] }),
        card({
          question: 'Which files?',
          multiSelect: true,
          options: [option('a.ts')],
        }),
      ]),
    ).toEqual({
      text: '[Color] Which color?\nWhich files? (pick one or more)',
      options: ['Red', 'Blue', 'a.ts'],
    });
  });

  it('opens with the lead when the request names the whole ask', () => {
    expect(adapterQuestionOf([card({})], 'Set up the review')?.text).toBe(
      'Set up the review\nWhich color?',
    );
  });
});

describe('secretAnswerParts', () => {
  const card = (over: Partial<CardQuestion>): CardQuestion => ({
    question: 'Which region?',
    header: null,
    multiSelect: false,
    options: [],
    ...over,
  });

  it('pins the label cut to the NUMBER the renderer restates as a literal', () => {
    // The card composing the submission cannot import this, so it hardcodes
    // 80; every other case below derives from the constant, and this line is
    // what turns a drift between the two into a failure.
    expect(MAX_ANSWER_LABEL_LENGTH).toBe(80);
  });

  it('answers a lone question with the whole submission, whatever it looks like', () => {
    expect(
      secretAnswerParts('Which region?: eu', [card({ secret: true })]),
    ).toEqual(['Which region?: eu']);
  });

  it('reads each secret question’s value off its own line', () => {
    expect(
      secretAnswerParts('Which region?: eu-west\nYour token?: ghp_abc', [
        card({}),
        card({ question: 'Your token?', secret: true }),
      ]),
    ).toEqual(['Which region?: eu-west\nYour token?: ghp_abc', 'ghp_abc']);
  });

  it('finds the line of a question whose label the card cut short', () => {
    const long = `${'x'.repeat(MAX_ANSWER_LABEL_LENGTH + 5)}?`;
    const label = `${long.slice(0, MAX_ANSWER_LABEL_LENGTH - 1)}…`;
    expect(
      secretAnswerParts(`Which region?: eu\n${label}: s3cret-value`, [
        card({}),
        card({ question: long, secret: true }),
      ]),
    ).toEqual([`Which region?: eu\n${label}: s3cret-value`, 's3cret-value']);
  });

  it('reads the value of a secret question whose text runs over several lines', () => {
    const answer = 'Name?: bob\nAPI token?\n(from the dashboard): tok_9f2k';
    expect(
      secretAnswerParts(answer, [
        card({ question: 'Name?' }),
        card({ question: 'API token?\n(from the dashboard)', secret: true }),
      ]),
    ).toEqual([answer, 'tok_9f2k']);
  });

  it('keeps only the whole submission when the secret’s line is not there', () => {
    expect(
      secretAnswerParts('something typed freely', [
        card({}),
        card({ question: 'Your token?', secret: true }),
      ]),
    ).toEqual(['something typed freely']);
  });
});

describe('answersByQuestion', () => {
  const card = (question: string): CardQuestion => ({
    question,
    header: null,
    multiSelect: false,
    options: [],
  });

  it('answers a lone question with the whole submission', () => {
    expect(answersByQuestion('Which?: eu', [card('Which?')])).toEqual([
      'Which?: eu',
    ]);
  });

  it('reads each question’s own value, in card order', () => {
    expect(
      answersByQuestion('Which region?: eu-west\nWhich size?: small', [
        card('Which region?'),
        card('Which size?'),
      ]),
    ).toEqual(['eu-west', 'small']);
  });

  it('keeps the lines a value ran onto — an image note rides one of its own', () => {
    expect(
      answersByQuestion(
        'What broke?: the dock\nWhere?: \n(1 image attached — sent as the next message)\nHow often?: once',
        [card('What broke?'), card('Where?'), card('How often?')],
      ),
    ).toEqual([
      'the dock',
      '\n(1 image attached — sent as the next message)',
      'once',
    ]);
  });

  it('tells apart two questions asked in the same words, by their order', () => {
    expect(
      answersByQuestion('Why?: first\nWhy?: second', [
        card('Why?'),
        card('Why?'),
      ]),
    ).toEqual(['first', 'second']);
  });

  it('answers null for a question whose line is missing, and keeps the rest', () => {
    expect(
      answersByQuestion('Which size?: small', [
        card('Which region?'),
        card('Which size?'),
      ]),
    ).toEqual([null, 'small']);
  });

  it('finds a question whose text holds a line break of its own', () => {
    expect(
      answersByQuestion(
        'Which env?\n(staging or prod): prod\nWhich size?: small',
        [card('Which env?\n(staging or prod)'), card('Which size?')],
      ),
    ).toEqual(['prod', 'small']);
  });

  it('opens only a LATER question, so a value quoting an earlier label stays its continuation', () => {
    expect(
      answersByQuestion('A?: x\nB?: y\nA?: z', [card('A?'), card('B?')]),
    ).toEqual(['x', 'y\nA?: z']);
  });
});
