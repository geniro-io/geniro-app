import { describe, expect, it, vi } from 'vitest';

import { type HostQuestion, type HostQuestionOutcome } from '../chat.types';
import { StandingQuestions } from './standing-questions';

const QUESTIONS: HostQuestion[] = [
  { question: 'Which database?', options: [{ label: 'SQLite' }] },
];

const SWEPT: HostQuestionOutcome = {
  status: 'unavailable',
  reason: 'the turn ended before the question was answered',
};

const ABANDONED: HostQuestionOutcome = {
  status: 'unavailable',
  reason: 'the agent stopped waiting for this answer',
};

describe('StandingQuestions.keyFor', () => {
  it('gives a re-ask with the identical words the same card', () => {
    expect(StandingQuestions.keyFor('Pick one', QUESTIONS)).toBe(
      StandingQuestions.keyFor('Pick one', QUESTIONS),
    );
  });

  it('gives a REWORDED question its own card', () => {
    expect(StandingQuestions.keyFor('Pick one', QUESTIONS)).not.toBe(
      StandingQuestions.keyFor('Pick one', [
        { question: 'Which store?', options: [{ label: 'SQLite' }] },
      ]),
    );
  });
});

describe('StandingQuestions — one call on the line', () => {
  it('resolves the waiting call and takes the card down', () => {
    const cards = new StandingQuestions();
    const key = StandingQuestions.keyFor(null, QUESTIONS);
    const waiting = vi.fn();
    const card = cards.open(key, 'req-1', waiting);

    cards.deliver(key, card, { status: 'answered', answer: 'SQLite' });

    expect(waiting).toHaveBeenCalledWith({
      status: 'answered',
      answer: 'SQLite',
    });
    expect(cards.peek(key)).toBeUndefined();
  });

  it('sweeps a card nobody answered, so the parked call is not left waiting', () => {
    const cards = new StandingQuestions();
    const key = StandingQuestions.keyFor(null, QUESTIONS);
    const waiting = vi.fn();
    cards.open(key, 'req-1', waiting);

    cards.sweep(SWEPT);

    expect(waiting).toHaveBeenCalledWith(SWEPT);
    expect(cards.peek(key)).toBeUndefined();
  });
});

describe('StandingQuestions — the call gave up before the user answered', () => {
  it('DETACHES the call and leaves the card standing', () => {
    const cards = new StandingQuestions();
    const key = StandingQuestions.keyFor(null, QUESTIONS);
    const first = vi.fn();
    const card = cards.open(key, 'req-1', first);

    expect(cards.detach(card, first)).toBe(true);
    expect(first).toHaveBeenCalledWith(ABANDONED);
    // The buttons still work: the card is still up and still answerable.
    expect(cards.peek(key)).toBe(card);
    expect(card.closed).toBe(false);
  });

  it('HOLDS an answer given while no call is in flight, and the retry collects it', () => {
    const cards = new StandingQuestions();
    const key = StandingQuestions.keyFor(null, QUESTIONS);
    const first = vi.fn();
    const card = cards.open(key, 'req-1', first);
    cards.detach(card, first);

    cards.deliver(key, card, { status: 'answered', answer: 'SQLite' });

    // The observable is that nobody was resolved and the outcome is collectable
    // — not a boolean the caller is documented never to branch on.
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(ABANDONED);
    expect(cards.collectHeld(key)).toEqual({
      status: 'answered',
      answer: 'SQLite',
    });
    // Collected once and forgotten — a second retry must not be handed it again.
    expect(cards.peek(key)).toBeUndefined();
  });

  it("does not let an OLD call's abort detach the retry that adopted the card", () => {
    const cards = new StandingQuestions();
    const key = StandingQuestions.keyFor(null, QUESTIONS);
    const first = vi.fn();
    const card = cards.open(key, 'req-1', first);
    const retry = vi.fn();
    cards.adopt(card, retry);

    expect(cards.detach(card, first)).toBe(false);
    expect(retry).not.toHaveBeenCalled();
    expect(card.waiting).toBe(retry);
  });
});

describe('StandingQuestions.adopt — the displaced resolver is settled, never dropped', () => {
  it('settles a live resolver it overwrites', () => {
    const cards = new StandingQuestions();
    const key = StandingQuestions.keyFor(null, QUESTIONS);
    const first = vi.fn();
    const card = cards.open(key, 'req-1', first);

    // The first client's deadline lapsed without its cancellation arriving, so
    // `first` is still parked when the retry adopts the card. Overwriting it
    // left that `tools/call` handler never returning — its hijacked HTTP
    // response never written and its socket open for the life of the process.
    const retry = vi.fn();
    cards.adopt(card, retry);

    expect(first).toHaveBeenCalledWith(ABANDONED);
    expect(card.waiting).toBe(retry);
    expect(retry).not.toHaveBeenCalled();
  });

  it('leaves the adopting call parked, so the user can still answer it', () => {
    const cards = new StandingQuestions();
    const key = StandingQuestions.keyFor(null, QUESTIONS);
    const card = cards.open(key, 'req-1', vi.fn());
    const retry = vi.fn();
    cards.adopt(card, retry);

    cards.deliver(key, card, { status: 'answered', answer: 'SQLite' });

    expect(retry).toHaveBeenCalledWith({
      status: 'answered',
      answer: 'SQLite',
    });
  });

  it('settles nothing when the card was already detached', () => {
    const cards = new StandingQuestions();
    const key = StandingQuestions.keyFor(null, QUESTIONS);
    const first = vi.fn();
    const card = cards.open(key, 'req-1', first);
    cards.detach(card, first);
    first.mockClear();

    cards.adopt(card, vi.fn());

    expect(first).not.toHaveBeenCalled();
  });

  it('does not settle a resolver adopting the card it already holds', () => {
    const cards = new StandingQuestions();
    const key = StandingQuestions.keyFor(null, QUESTIONS);
    const only = vi.fn();
    const card = cards.open(key, 'req-1', only);

    cards.adopt(card, only);

    expect(only).not.toHaveBeenCalled();
    expect(card.waiting).toBe(only);
  });
});

describe('StandingQuestions.sweep', () => {
  it('answers every card still open', () => {
    const cards = new StandingQuestions();
    const one = vi.fn();
    const two = vi.fn();
    cards.open(StandingQuestions.keyFor('a', QUESTIONS), 'req-1', one);
    cards.open(StandingQuestions.keyFor('b', QUESTIONS), 'req-2', two);

    cards.sweep(SWEPT);

    expect(one).toHaveBeenCalledWith(SWEPT);
    expect(two).toHaveBeenCalledWith(SWEPT);
  });

  it('does not re-answer a call the card already answered', () => {
    const cards = new StandingQuestions();
    const key = StandingQuestions.keyFor(null, QUESTIONS);
    const waiting = vi.fn();
    const card = cards.open(key, 'req-1', waiting);
    cards.deliver(key, card, { status: 'declined' });

    cards.sweep(SWEPT);

    expect(waiting).toHaveBeenCalledTimes(1);
    expect(waiting).toHaveBeenCalledWith({ status: 'declined' });
  });

  it('leaves a HELD answer alone — the retry still collects it', () => {
    const cards = new StandingQuestions();
    const key = StandingQuestions.keyFor(null, QUESTIONS);
    const first = vi.fn();
    const card = cards.open(key, 'req-1', first);
    cards.detach(card, first);
    cards.deliver(key, card, { status: 'answered', answer: 'SQLite' });

    cards.sweep(SWEPT);

    expect(cards.collectHeld(key)).toEqual({
      status: 'answered',
      answer: 'SQLite',
    });
  });
});
