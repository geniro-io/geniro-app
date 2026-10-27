import { BadRequestException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import type { Workflow, WorkflowStage } from '../graphs.types';
import {
  assertValidStages,
  startStageId,
  validateStages,
} from './stage-validate';
import { checkWorkflow } from './workflow-check';

const stage = (
  id: string,
  next?: string[],
  over: Partial<WorkflowStage> = {},
): WorkflowStage => ({
  id,
  title: id,
  doneWhen: `${id} is done`,
  ...(next ? { next } : {}),
  ...over,
});

const workflowWith = (stages: WorkflowStage[] | undefined): Workflow => ({
  name: 'w',
  nodes: [{ id: 'lead', kind: 'agent', agent: 'claude', approval: 'auto' }],
  edges: [],
  ...(stages ? { stages } : {}),
});

const codes = (stages: WorkflowStage[]): string[] =>
  validateStages(workflowWith(stages)).errors.map((e) => e.code);

const FORK = [
  stage('investigation', ['implementation', 'fix']),
  stage('implementation', ['review']),
  stage('fix', ['review']),
  stage('review', ['done']),
  stage('done'),
];

describe('validateStages', () => {
  it('accepts a fork and no stages at all', () => {
    expect(validateStages(workflowWith(FORK))).toEqual({
      errors: [],
      warnings: [],
    });
    expect(validateStages(workflowWith(undefined)).errors).toEqual([]);
    expect(validateStages(workflowWith([])).errors).toEqual([]);
  });

  it('rejects a cycle, two starts and a graph with no start', () => {
    expect(
      codes([stage('a', ['b']), stage('b', ['c']), stage('c', ['b'])]),
    ).toEqual(['STAGE_CYCLE']);
    expect(codes([stage('a', ['c']), stage('b', ['c']), stage('c')])).toEqual([
      'STAGE_MULTIPLE_STARTS',
    ]);
    expect(
      codes([
        stage('a', ['b']),
        stage('b'),
        stage('c', ['d']),
        stage('d', ['c']),
      ]),
    ).toEqual(['STAGE_CYCLE']);
    expect(codes([stage('a', ['a'])])).toEqual(['STAGE_NO_START']);
  });

  it('rejects duplicate ids, unknown and repeated next stages, and too many stages', () => {
    expect(codes([stage('a'), stage('a')])).toEqual(['STAGE_DUPLICATE_ID']);
    expect(codes([stage('a', ['ghost'])])).toEqual(['STAGE_NEXT_UNKNOWN']);
    expect(codes([stage('a', ['b', 'b']), stage('b')])).toEqual([
      'STAGE_NEXT_DUPLICATE',
    ]);
    const many = Array.from({ length: 21 }, (_, i) =>
      stage(`s${i}`, i < 20 ? [`s${i + 1}`] : undefined),
    );
    expect(codes(many)).toEqual(['STAGE_TOO_MANY']);
  });

  it('warns, not fails, on an ownerHint naming no agent', () => {
    const result = validateStages(
      workflowWith([stage('a', undefined, { ownerHint: 'deleted-agent' })]),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(['STAGE_OWNER_UNKNOWN']);
    expect(() =>
      assertValidStages(
        workflowWith([stage('a', undefined, { ownerHint: 'deleted-agent' })]),
      ),
    ).not.toThrow();
  });
});

describe('assertValidStages', () => {
  it('throws the first error with its code', () => {
    try {
      assertValidStages(workflowWith([stage('a', ['b']), stage('b', ['a'])]));
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).errorCode).toBe('STAGE_NO_START');
    }
  });
});

describe('checkWorkflow', () => {
  it('refuses a workflow whose stages cannot be walked', () => {
    const result = checkWorkflow(
      workflowWith([stage('a', ['b']), stage('b', ['c']), stage('c', ['b'])]),
    );
    expect(result).toMatchObject({ ok: false, code: 'STAGE_CYCLE' });
  });
});

describe('startStageId', () => {
  it('is the stage no other stage names', () => {
    expect(startStageId(FORK)).toBe('investigation');
  });
});
