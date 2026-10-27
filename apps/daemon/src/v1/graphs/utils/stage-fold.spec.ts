import { describe, expect, it } from 'vitest';

import type { StageProgress } from '../../agents/chat.types';
import type { WorkflowStage } from '../graphs.types';
import { foldStages, type StageMove, stagesReopenResets } from './stage-fold';

const S: WorkflowStage[] = [
  {
    id: 'investigation',
    title: 'Investigation',
    doneWhen: 'cause known',
    next: ['implementation', 'fix'],
  },
  {
    id: 'implementation',
    title: 'Implementation',
    doneWhen: 'built',
    next: ['review'],
  },
  { id: 'fix', title: 'Fix', doneWhen: 'fixed', next: ['review'] },
  { id: 'review', title: 'Review', doneWhen: 'approved' },
];

const AGENT = { kind: 'agent', nodeId: 'lead' } as const;
let clock = 0;
const move = (
  action: StageMove['action'],
  stageId: string,
  extra: Partial<StageMove> = {},
): StageMove => ({
  action,
  stageId,
  text: `${action} ${stageId}`,
  by: AGENT,
  at: new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
  ...extra,
});
const complete = (stageId: string, extra: Partial<StageMove> = {}) =>
  move('complete', stageId, extra);
const statusOf = (p: StageProgress, id: string) =>
  p.stages.find((s) => s.id === id)?.status;

describe('foldStages', () => {
  it('starts at the first stage with every other stage pending', () => {
    const p = foldStages(S, []);
    expect(p.rev).toBe(0);
    expect(p.current).toBe('investigation');
    expect(p.stages.map((s) => s.status)).toEqual([
      'current',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('counts n/m along the first-listed branch until chosen', () => {
    expect(foldStages(S, []).position).toEqual({ index: 1, total: 3 });
  });

  it('marks the untaken branch not_taken', () => {
    const p = foldStages(S, [complete('investigation', { next: 'fix' })]);
    expect(statusOf(p, 'implementation')).toBe('not_taken');
    expect(statusOf(p, 'review')).toBe('pending');
    expect(p.current).toBe('fix');
    expect(p.position).toEqual({ index: 2, total: 3 });
    const done = p.stages.find((s) => s.id === 'investigation')!;
    expect(done).toMatchObject({
      status: 'done',
      chosen: 'fix',
      by: AGENT,
      text: 'complete investigation',
      rev: 1,
    });
  });

  it('records a skip and finishes after the last stage', () => {
    const p = foldStages(S, [
      complete('investigation', { next: 'fix' }),
      move('skip', 'fix', { text: 'nothing to fix' }),
      complete('review'),
    ]);
    expect(statusOf(p, 'fix')).toBe('skipped');
    expect(p.current).toBeNull();
    expect(p.rev).toBe(3);
    expect(p.position).toEqual({ index: 3, total: 3 });
  });

  it('reopen resets later stages and clears the fork choice', () => {
    const p = foldStages(S, [
      complete('investigation', { next: 'fix' }),
      complete('fix'),
      move('reopen', 'investigation', { by: { kind: 'user', via: 'desktop' } }),
    ]);
    expect(p.current).toBe('investigation');
    expect(p.rev).toBe(3);
    expect(statusOf(p, 'fix')).toBe('pending');
    expect(statusOf(p, 'implementation')).toBe('pending');
    const reopened = p.stages.find((s) => s.id === 'investigation')!;
    expect(reopened.chosen).toBeUndefined();
    expect(reopened.text).toBeUndefined();
    expect(Object.fromEntries(p.stages.map((s) => [s.id, s.rev]))).toEqual({
      investigation: 3,
      implementation: 3,
      fix: 3,
      review: 3,
    });
  });

  it('keeps stages before a reopened one, and the move that set them', () => {
    const p = foldStages(S, [
      complete('investigation', { next: 'fix' }),
      complete('fix'),
      move('reopen', 'fix'),
    ]);
    expect(statusOf(p, 'investigation')).toBe('done');
    expect(p.current).toBe('fix');
    expect(statusOf(p, 'implementation')).toBe('not_taken');
    expect(Object.fromEntries(p.stages.map((s) => [s.id, s.rev]))).toEqual({
      investigation: 1,
      implementation: undefined,
      fix: 3,
      review: 3,
    });
  });

  it('a stage finished after its reopen names the finishing move', () => {
    const p = foldStages(S, [
      complete('investigation', { next: 'fix' }),
      move('reopen', 'investigation'),
      complete('investigation', { next: 'implementation' }),
    ]);
    expect(p.stages.find((s) => s.id === 'investigation')?.rev).toBe(3);
    expect(p.stages.find((s) => s.id === 'fix')?.rev).toBe(2);
  });

  it('skips a move that does not fit the state it meets', () => {
    const p = foldStages(S, [
      complete('review'),
      complete('investigation'),
      move('reopen', 'fix'),
      complete('ghost'),
    ]);
    expect(p.rev).toBe(0);
    expect(p.current).toBe('investigation');
  });
});

describe('stagesReopenResets', () => {
  it('names the finished and current stages after the reopened one', () => {
    const p = foldStages(S, [
      complete('investigation', { next: 'fix' }),
      complete('fix'),
    ]);
    expect(stagesReopenResets(S, p, 'investigation')).toEqual([
      'fix',
      'review',
    ]);
    expect(stagesReopenResets(S, p, 'fix')).toEqual(['review']);
  });
});
