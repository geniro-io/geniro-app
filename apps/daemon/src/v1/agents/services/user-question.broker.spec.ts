import { describe, expect, it } from 'vitest';

import type { HostQuestion } from '../chat.types';
import { UserQuestionBroker } from './user-question.broker';

const QUESTIONS: HostQuestion[] = [
  { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
];

describe('UserQuestionBroker', () => {
  it('reports unavailable when no turn is registered, rather than hanging', async () => {
    const broker = new UserQuestionBroker();
    expect(broker.canAsk('run-1', 'agent')).toBe(false);
    const outcome = await broker.ask('run-1', 'agent', QUESTIONS, null);
    expect(outcome.status).toBe('unavailable');
  });

  it('hands the question to the registered asker and returns its outcome', async () => {
    const broker = new UserQuestionBroker();
    const seen: HostQuestion[][] = [];
    broker.register('run-1', 'agent', async (questions) => {
      seen.push(questions);
      return { status: 'answered', answer: 'A' };
    });
    expect(broker.canAsk('run-1', 'agent')).toBe(true);
    expect(await broker.ask('run-1', 'agent', QUESTIONS, null)).toEqual({
      status: 'answered',
      answer: 'A',
    });
    expect(seen).toEqual([QUESTIONS]);
  });

  it('keys by node, so one run’s node cannot answer another’s', async () => {
    const broker = new UserQuestionBroker();
    broker.register('run-1', 'agent', async () => ({
      status: 'answered',
      answer: 'A',
    }));
    expect(broker.canAsk('run-1', 'other')).toBe(false);
    expect(broker.canAsk('run-2', 'agent')).toBe(false);
  });

  it('turns an asker that throws into an outcome, never a tool error', async () => {
    const broker = new UserQuestionBroker();
    broker.register('run-1', 'agent', async () => {
      throw new Error('the card could not be written');
    });
    const outcome = await broker.ask('run-1', 'agent', QUESTIONS, null);
    expect(outcome).toEqual({
      status: 'unavailable',
      reason: 'the card could not be written',
    });
  });

  it('disposes only its OWN asker, so a settling turn cannot unregister its successor', async () => {
    const broker = new UserQuestionBroker();
    const disposeFirst = broker.register('run-1', 'agent', async () => ({
      status: 'answered',
      answer: 'first',
    }));
    broker.register('run-1', 'agent', async () => ({
      status: 'answered',
      answer: 'second',
    }));

    disposeFirst();

    expect(broker.canAsk('run-1', 'agent')).toBe(true);
    expect(await broker.ask('run-1', 'agent', QUESTIONS, null)).toEqual({
      status: 'answered',
      answer: 'second',
    });
  });
});
