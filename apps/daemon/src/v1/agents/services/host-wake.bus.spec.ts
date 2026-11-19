import { describe, expect, it } from 'vitest';

import {
  type HostRowWire,
  type HostWake,
  SINGLE_AGENT_NODE,
  type ThreadDoneRow,
} from '../chat.types';
import { joinHostWakes } from './host-wake.bus';

function wake(key: string, row: Partial<HostRowWire>): HostWake {
  return {
    key,
    owner: {
      target: 'chat',
      runId: 'manager',
      memberId: SINGLE_AGENT_NODE,
      conversationId: null,
      caller: SINGLE_AGENT_NODE,
    },
    prompt: `prompt ${key}`,
    row: { severity: 'info', message: `message ${key}`, woke: true, ...row },
    note: null,
    onDelivered: () => undefined,
  };
}

const done = (runId: string, handle: string): ThreadDoneRow => ({
  runId,
  title: `Thread ${handle}`,
  handle,
  summary: null,
  pullRequest: null,
});

describe('joinHostWakes', () => {
  it('keeps every finished thread when several done wakes open one turn', () => {
    const { row } = joinHostWakes([
      wake('done:r1', { threadDone: [done('r1', 't1')] }),
      wake('question:r3', {}),
      wake('done:r2', { threadDone: [done('r2', 't2')] }),
    ]);

    expect(row.threadDone).toEqual([done('r1', 't1'), done('r2', 't2')]);
  });

  it('carries no finished threads when no wake named one', () => {
    const { row } = joinHostWakes([wake('a', {}), wake('b', {})]);

    expect(row).not.toHaveProperty('threadDone');
  });
});
