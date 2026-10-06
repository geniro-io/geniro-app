import { describe, expect, it } from 'vitest';

import type { RunStatusEvent } from '../chat.types';
import {
  type AttentionMemory,
  NO_ATTENTION_MEMORY,
  readAttention,
} from './run-attention';

function event(fields: Partial<RunStatusEvent>): RunStatusEvent {
  return { runId: 'r1', status: null, ...fields };
}

/** Feed a sequence of announces through, answering which of them earned a mark. */
function marks(events: RunStatusEvent[]): boolean[] {
  let memory: AttentionMemory = NO_ATTENTION_MEMORY;
  return events.map((next) => {
    const { earns, after } = readAttention(next, memory);
    memory = after;
    return earns;
  });
}

describe('readAttention', () => {
  it('marks a turn that finished or failed', () => {
    expect(
      marks([event({ status: 'running' }), event({ status: 'completed' })]),
    ).toEqual([false, true]);
    expect(
      marks([event({ status: 'running' }), event({ status: 'failed' })]),
    ).toEqual([false, true]);
  });

  it('does not mark a turn the user cancelled', () => {
    expect(
      marks([event({ status: 'running' }), event({ status: 'cancelled' })]),
    ).toEqual([false, false]);
  });

  it('marks the same ending only once, however often it is restated', () => {
    expect(
      marks([
        event({ status: 'running' }),
        event({ status: 'completed' }),
        event({ status: 'completed' }),
        event({ status: null, activity: null }),
      ]),
    ).toEqual([false, true, false, false]);
  });

  it('marks the NEXT turn ending again', () => {
    expect(
      marks([
        event({ status: 'completed' }),
        event({ status: 'running' }),
        event({ status: 'completed' }),
      ]),
    ).toEqual([true, false, true]);
  });

  it('does not mark a compaction-only turn or a status handed back', () => {
    expect(
      marks([
        event({ status: 'running' }),
        event({ status: 'completed', housekeeping: true }),
      ]),
    ).toEqual([false, false]);
    expect(
      marks([
        event({ status: 'running' }),
        event({ status: 'completed', restored: true }),
      ]),
    ).toEqual([false, false]);
  });

  it('marks a card going up once, not on every announce that restates it', () => {
    expect(
      marks([
        event({ status: 'running' }),
        event({ status: null, awaiting: 'question' }),
        event({ status: null, awaiting: 'question', activity: 'x' }),
        event({ status: null, activity: 'y' }),
        event({ status: null, awaiting: null }),
        event({ status: null, awaiting: 'approval' }),
      ]),
    ).toEqual([false, true, false, false, false, true]);
  });

  it('never marks off its own announcements', () => {
    expect(
      marks([
        event({ status: 'running' }),
        event({ status: null, attentionAt: '2026-01-01T00:00:00.000Z' }),
        event({ status: null, seenAt: '2026-01-01T00:00:01.000Z' }),
      ]),
    ).toEqual([false, false, false]);
  });
});
