import { describe, expect, it } from 'vitest';

import { AgentKind } from '../../../../runs/runs.types';
import type { SubagentRecoveryRef } from '../../adapter.types';
import { recoverCodexSubagent } from './codex-subagent-recovery.utils';

const parentId = '019cf395-e26d-77b5-a3de-d7d48cdf7e57';
const childId = '019cf395-e26d-77b5-a3de-d7d48cdf7e58';
const ref: SubagentRecoveryRef = {
  agentKind: AgentKind.Codex,
  sessionId: parentId,
  childSessionId: childId,
  toolCallId: 'spawn-1',
  launchedAtMs: 1_800_000_000_500,
  configDir: '/profile',
  cwd: '/repo',
};
const completed = {
  status: 'completed',
  startedAt: 1_800_000_000,
  completedAt: 1_800_000_001,
};
function reply(thread: Record<string, unknown> = {}): unknown {
  return {
    thread: {
      id: childId,
      parentThreadId: parentId,
      status: { type: 'notLoaded' },
      turns: [completed],
      ...thread,
    },
  };
}

describe('recoverCodexSubagent', () => {
  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['errored', 'failed'],
    ['interrupted', 'stopped'],
    ['cancelled', 'stopped'],
    ['shutdown', 'stopped'],
  ])('maps the latest dated %s turn to %s', (status, outcome) => {
    expect(
      recoverCodexSubagent(ref, reply({ turns: [{ ...completed, status }] })),
    ).toBe(outcome);
  });

  it.each([
    { id: parentId },
    { id: undefined },
    { parentThreadId: childId },
    { parentThreadId: undefined },
    { parentThreadId: null },
  ])('requires the native child and parent identity: %j', (identity) => {
    expect(recoverCodexSubagent(ref, reply(identity))).toBeNull();
  });

  it.each([null, {}, { thread: null }, { thread: [] }])(
    'leaves a malformed response unknown: %j',
    (result) => {
      expect(recoverCodexSubagent(ref, result)).toBeNull();
    },
  );

  it.each([undefined, null, [], {}, [completed, null]])(
    'requires a latest turn: %j',
    (turns) => {
      expect(recoverCodexSubagent(ref, reply({ turns }))).toBeNull();
    },
  );

  it.each(['inProgress', 'pending', 'unknown', undefined, null])(
    'withholds historical completion when the latest status is %s',
    (status) => {
      expect(
        recoverCodexSubagent(
          ref,
          reply({ turns: [completed, { ...completed, status }] }),
        ),
      ).toBeNull();
    },
  );

  it.each([
    { startedAt: undefined },
    { completedAt: undefined },
    { startedAt: null },
    { completedAt: null },
    { startedAt: '1800000000' },
    { completedAt: '1800000001' },
    { startedAt: Number.NaN },
    { completedAt: Number.NaN },
    { startedAt: Number.POSITIVE_INFINITY },
    { completedAt: Number.POSITIVE_INFINITY },
    { startedAt: 0 },
    { completedAt: 0 },
    { startedAt: -1 },
    { completedAt: -1 },
    { startedAt: 1_800_000_002 },
    { startedAt: 1_799_999_998, completedAt: 1_799_999_999 },
    { completedAt: 1_800_000_000 },
  ])('requires current, finite, ordered Unix-second dates: %j', (dates) => {
    expect(
      recoverCodexSubagent(ref, reply({ turns: [{ ...completed, ...dates }] })),
    ).toBeNull();
  });

  it('accepts an ending exactly at the launch boundary', () => {
    expect(
      recoverCodexSubagent(
        { ...ref, launchedAtMs: completed.completedAt * 1000 },
        reply(),
      ),
    ).toBe('completed');
  });

  it.each([
    { type: 'active', activeFlags: [] },
    { type: 'active', activeFlags: ['waitingOnApproval'] },
  ])('withholds history while the native runtime is active: %j', (status) => {
    expect(recoverCodexSubagent(ref, reply({ status }))).toBeNull();
  });

  it.each([
    { childSessionId: null },
    { childSessionId: '../escape' },
    { sessionId: 'not-a-uuid' },
    { launchedAtMs: Number.NaN },
    { launchedAtMs: Number.POSITIVE_INFINITY },
    { launchedAtMs: -1 },
  ])('rejects an invalid recovery reference: %j', (invalid) => {
    expect(recoverCodexSubagent({ ...ref, ...invalid }, reply())).toBeNull();
  });
});
