import { describe, expect, it } from 'vitest';

import {
  type AgentCallEvent,
  memberIdOfEvent,
  readAgentCallEvents,
} from './agent-event-payload';

const finishedEvent = (
  fields: Partial<AgentCallEvent> & Pick<AgentCallEvent, 'callId' | 'callee'>,
): AgentCallEvent => ({
  kind: 'finished',
  calleeMemberId: null,
  status: null,
  result: null,
  question: null,
  options: [],
  noAnswer: null,
  delivery: null,
  ...fields,
});

describe('readAgentCallEvents — structured keys', () => {
  it('reads a finished wake reason with its status and result', () => {
    expect(
      readAgentCallEvents({
        message: 'Picked back up — Ada Lovelace finished call-1.',
        wake: [
          {
            callId: 'call-1',
            callee: 'Ada Lovelace',
            reason: 'finished',
            calleeNodeId: 'node-ada',
            status: 'completed',
            result: 'Shipped the parser.',
          },
        ],
      }),
    ).toEqual([
      finishedEvent({
        callId: 'call-1',
        callee: 'Ada Lovelace',
        calleeMemberId: 'node-ada',
        status: 'completed',
        result: 'Shipped the parser.',
        delivery: 'woke',
      }),
    ]);
  });

  it('reads an asked wake reason with its question and string options only', () => {
    expect(
      readAgentCallEvents({
        wake: [
          {
            callId: 'call-2',
            callee: 'Peter Parker',
            reason: 'asked',
            calleeNodeId: 'node-peter',
            question: 'Which stand?',
            options: ['Local', 'Sandbox', 3],
          },
        ],
      }),
    ).toEqual([
      {
        kind: 'asked',
        callId: 'call-2',
        callee: 'Peter Parker',
        calleeMemberId: 'node-peter',
        status: null,
        result: null,
        question: 'Which stand?',
        options: ['Local', 'Sandbox'],
        noAnswer: null,
        delivery: 'woke',
      },
    ]);
  });

  it('keeps only the three statuses a call can end with', () => {
    expect(
      readAgentCallEvents({
        wake: [
          {
            callId: 'call-3',
            callee: 'Tony Stark',
            reason: 'finished',
            status: 'running',
          },
        ],
      }),
    ).toEqual([
      finishedEvent({
        callId: 'call-3',
        callee: 'Tony Stark',
        delivery: 'woke',
      }),
    ]);
  });

  it('skips a malformed wake entry and keeps the valid ones', () => {
    expect(
      readAgentCallEvents({
        wake: [
          'not an entry',
          { callId: '', callee: 'Nobody', reason: 'asked' },
          { callId: 'call-4', callee: 'Tony Stark', reason: 'finished' },
        ],
      }),
    ).toEqual([
      finishedEvent({
        callId: 'call-4',
        callee: 'Tony Stark',
        delivery: 'woke',
      }),
    ]);
  });

  it('falls through to the stored text when every wake entry is malformed', () => {
    expect(
      readAgentCallEvents({
        message:
          'Told this agent that Tony Stark finished call-5 while it was working.',
        wake: [{ callId: 'call-x', callee: 'Nobody', reason: 'sleeping' }],
      }),
    ).toEqual([
      finishedEvent({
        callId: 'call-5',
        callee: 'Tony Stark',
        delivery: 'told',
      }),
    ]);
  });

  it('reads a toldWorking object as one finished event', () => {
    expect(
      readAgentCallEvents({
        message:
          'Told this agent that Ada Lovelace finished call-6 while it was working.',
        toldWorking: {
          callId: 'call-6',
          callee: 'Ada Lovelace',
          calleeNodeId: 'node-ada',
          reason: 'finished',
          status: 'failed',
        },
      }),
    ).toEqual([
      finishedEvent({
        callId: 'call-6',
        callee: 'Ada Lovelace',
        calleeMemberId: 'node-ada',
        status: 'failed',
        delivery: 'told',
      }),
    ]);
  });

  it('reads a toldWorking object asking a question', () => {
    expect(
      readAgentCallEvents({
        toldWorking: {
          callId: 'call-7',
          callee: 'Peter Parker',
          calleeNodeId: 'node-peter',
          reason: 'asked',
          question: 'Proceed?',
          options: ['yes', 'no'],
        },
      }),
    ).toEqual([
      {
        kind: 'asked',
        callId: 'call-7',
        callee: 'Peter Parker',
        calleeMemberId: 'node-peter',
        status: null,
        result: null,
        question: 'Proceed?',
        options: ['yes', 'no'],
        noAnswer: null,
        delivery: 'told',
      },
    ]);
  });

  it('reads an orphan question that goes on without an answer', () => {
    expect(
      readAgentCallEvents({
        orphanQuestion: {
          callId: 'call-8',
          callee: 'Peter Parker',
          calleeNodeId: 'node-peter',
          outcome: 'continues',
        },
      }),
    ).toEqual([
      {
        kind: 'no-answer',
        callId: 'call-8',
        callee: 'Peter Parker',
        calleeMemberId: 'node-peter',
        status: null,
        result: null,
        question: null,
        options: [],
        noAnswer: 'continues',
        delivery: null,
      },
    ]);
  });

  it('reads an orphan question whose callee was stopped', () => {
    expect(
      readAgentCallEvents({
        orphanQuestion: {
          callId: 'call-9',
          callee: 'Peter Parker',
          calleeNodeId: 'node-peter',
          outcome: 'stopped',
        },
      }),
    ).toEqual([
      {
        kind: 'no-answer',
        callId: 'call-9',
        callee: 'Peter Parker',
        calleeMemberId: 'node-peter',
        status: null,
        result: null,
        question: null,
        options: [],
        noAnswer: 'stopped',
        delivery: null,
      },
    ]);
  });

  it('prefers the structured wake key over the stored sentence', () => {
    expect(
      readAgentCallEvents({
        message:
          'Told this agent that Ada Lovelace finished call-10 while it was working.',
        wake: [{ callId: 'call-11', callee: 'Tony Stark', reason: 'finished' }],
      }),
    ).toEqual([
      finishedEvent({
        callId: 'call-11',
        callee: 'Tony Stark',
        delivery: 'woke',
      }),
    ]);
  });
});

describe('readAgentCallEvents — stored sentences', () => {
  it('reads a told-finished sentence', () => {
    expect(
      readAgentCallEvents({
        message:
          'Told this agent that Ada Lovelace finished call-12 while it was working.',
      }),
    ).toEqual([
      finishedEvent({
        callId: 'call-12',
        callee: 'Ada Lovelace',
        delivery: 'told',
      }),
    ]);
  });

  it('reads a passed-question sentence, with an apostrophe-free name', () => {
    expect(
      readAgentCallEvents({
        message:
          "Passed Peter's question in call-13 to this agent while it was working.",
      }),
    ).toEqual([
      {
        kind: 'asked',
        callId: 'call-13',
        callee: 'Peter',
        calleeMemberId: null,
        status: null,
        result: null,
        question: null,
        options: [],
        noAnswer: null,
        delivery: 'told',
      },
    ]);
  });

  it('reads a passed-question sentence whose name contains an apostrophe', () => {
    expect(
      readAgentCallEvents({
        message:
          "Passed Rita O'Brien's question in call-14 to this agent while it was working.",
      }),
    ).toEqual([
      {
        kind: 'asked',
        callId: 'call-14',
        callee: "Rita O'Brien",
        calleeMemberId: null,
        status: null,
        result: null,
        question: null,
        options: [],
        noAnswer: null,
        delivery: 'told',
      },
    ]);
  });

  it('splits a picked-back-up sentence with two reasons into two events', () => {
    expect(
      readAgentCallEvents({
        message:
          'Picked back up — Ada Lovelace asked a question in call-15; Peter Parker finished call-16.',
      }),
    ).toEqual([
      {
        kind: 'asked',
        callId: 'call-15',
        callee: 'Ada Lovelace',
        calleeMemberId: null,
        status: null,
        result: null,
        question: null,
        options: [],
        noAnswer: null,
        delivery: 'woke',
      },
      finishedEvent({
        callId: 'call-16',
        callee: 'Peter Parker',
        delivery: 'woke',
      }),
    ]);
  });

  it('reads the older started-another-turn sentence the same way', () => {
    expect(
      readAgentCallEvents({
        message:
          'Started another turn for this agent: Ada Lovelace finished call-17; Peter Parker asked a question in call-18 after its turn had ended.',
      }),
    ).toEqual([
      finishedEvent({
        callId: 'call-17',
        callee: 'Ada Lovelace',
        delivery: 'woke',
      }),
      {
        kind: 'asked',
        callId: 'call-18',
        callee: 'Peter Parker',
        calleeMemberId: null,
        status: null,
        result: null,
        question: null,
        options: [],
        noAnswer: null,
        delivery: 'woke',
      },
    ]);
  });

  it('returns null for a picked-back-up sentence with one part it cannot read', () => {
    expect(
      readAgentCallEvents({
        message:
          'Picked back up — Ada Lovelace asked a question in call-19; something unreadable.',
      }),
    ).toBeNull();
  });

  it('reads a question that goes on without an answer', () => {
    expect(
      readAgentCallEvents({
        message:
          'Ada Lovelace asked a question in call-20 and no turn of this agent was left to answer it, so it goes on without an answer.',
      }),
    ).toEqual([
      {
        kind: 'no-answer',
        callId: 'call-20',
        callee: 'Ada Lovelace',
        calleeMemberId: null,
        status: null,
        result: null,
        question: null,
        options: [],
        noAnswer: 'continues',
        delivery: null,
      },
    ]);
  });

  it('reads a stopped callee whose question had no turn left to answer it', () => {
    expect(
      readAgentCallEvents({
        message:
          'Peter Parker was stopped: it asked a question in call-21 and no turn of this agent was left to answer it.',
      }),
    ).toEqual([
      {
        kind: 'no-answer',
        callId: 'call-21',
        callee: 'Peter Parker',
        calleeMemberId: null,
        status: null,
        result: null,
        question: null,
        options: [],
        noAnswer: 'stopped',
        delivery: null,
      },
    ]);
  });

  it('returns null for an info message it does not recognise', () => {
    expect(
      readAgentCallEvents({ message: 'The daemon restarted.' }),
    ).toBeNull();
  });
});

describe('readAgentCallEvents — nothing to read', () => {
  it('returns null for a payload that is not an object', () => {
    expect(readAgentCallEvents(null)).toBeNull();
    expect(readAgentCallEvents(undefined)).toBeNull();
    expect(
      readAgentCallEvents(
        'Told this agent that A finished call-1 while it was working.',
      ),
    ).toBeNull();
  });

  it('returns null for an object with neither a structured key nor a message', () => {
    expect(readAgentCallEvents({ severity: 'info' })).toBeNull();
  });

  it('returns null when the message is not a string', () => {
    expect(readAgentCallEvents({ message: 42 })).toBeNull();
  });
});

describe('memberIdOfEvent', () => {
  const nodes = new Map([
    ['node-ada', { name: 'Ada Lovelace' }],
    ['node-peter', { name: 'Peter Parker' }],
  ]);

  it('returns the event own member id when that member is in the team', () => {
    expect(
      memberIdOfEvent(
        finishedEvent({
          callId: 'call-1',
          callee: 'Ada Lovelace',
          calleeMemberId: 'node-ada',
        }),
        nodes,
      ),
    ).toBe('node-ada');
  });

  it('matches the one member whose name is the callee', () => {
    expect(
      memberIdOfEvent(
        finishedEvent({ callId: 'call-4', callee: 'Peter Parker' }),
        nodes,
      ),
    ).toBe('node-peter');
  });

  it('answers null when two members share the callee name', () => {
    const duplicated = new Map([
      ['node-a', { name: 'Ada Lovelace' }],
      ['node-b', { name: 'Ada Lovelace' }],
    ]);
    expect(
      memberIdOfEvent(
        finishedEvent({ callId: 'call-5', callee: 'Ada Lovelace' }),
        duplicated,
      ),
    ).toBeNull();
  });

  it('answers null when no member has the callee name', () => {
    expect(
      memberIdOfEvent(
        finishedEvent({ callId: 'call-6', callee: 'Nobody' }),
        nodes,
      ),
    ).toBeNull();
  });

  it('returns the event own id without a team to check it against', () => {
    expect(
      memberIdOfEvent(
        finishedEvent({
          callId: 'call-7',
          callee: 'Ada Lovelace',
          calleeMemberId: 'node-ada',
        }),
        undefined,
      ),
    ).toBe('node-ada');
  });

  it('answers null without a team when the event carries no id', () => {
    expect(
      memberIdOfEvent(
        finishedEvent({ callId: 'call-8', callee: 'Ada Lovelace' }),
        undefined,
      ),
    ).toBeNull();
  });
});
