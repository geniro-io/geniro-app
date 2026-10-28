import { describe, expect, it } from 'vitest';

import type { Workflow, WorkflowStage } from '../graphs.types';
import { diffWorkflows } from './workflow-diff';

function stage(id: string, extra: Partial<WorkflowStage> = {}): WorkflowStage {
  return { id, title: id, doneWhen: `${id} is done`, ...extra };
}

function workflow(stages?: WorkflowStage[]): Workflow {
  return {
    name: 'Team',
    nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual' }],
    edges: [],
    ...(stages === undefined ? {} : { stages }),
  } as Workflow;
}

describe('diffWorkflows — stages', () => {
  it('names each added, removed and changed stage by id instead of the whole field', () => {
    const before = workflow([
      stage('plan', { next: ['build'] }),
      stage('build'),
      stage('old'),
    ]);
    const after = workflow([
      stage('plan', { next: ['build'] }),
      stage('build', { doneWhen: 'tests pass', next: ['review'] }),
      stage('review'),
    ]);

    const diff = diffWorkflows(before, after);

    expect(diff.identical).toBe(false);
    expect(diff.workflowFields).toEqual([]);
    expect(diff.addedStages).toEqual(['review']);
    expect(diff.removedStages).toEqual(['old']);
    expect(diff.changedStages).toEqual([
      {
        id: 'build',
        fields: [
          {
            field: 'doneWhen',
            before: '"build is done"',
            after: '"tests pass"',
          },
          { field: 'next', before: '(unset)', after: '["review"]' },
        ],
      },
    ]);
  });

  it('reports a first stage list on a workflow that had none as added stages', () => {
    const diff = diffWorkflows(
      workflow(),
      workflow([stage('plan', { next: ['build'] }), stage('build')]),
    );

    expect(diff.addedStages).toEqual(['plan', 'build']);
    expect(diff.identical).toBe(false);
  });

  it('reports a reorder of kept stages as the stages field, since no stage changed', () => {
    const diff = diffWorkflows(
      workflow([stage('a'), stage('b')]),
      workflow([stage('b'), stage('a')]),
    );

    expect(diff.workflowFields).toEqual(['stages']);
    expect(diff.changedStages).toEqual([]);
    expect(diff.identical).toBe(false);
  });

  it('is identical when the stages are the same', () => {
    const stages = [stage('a', { next: ['b'] }), stage('b')];

    expect(
      diffWorkflows(workflow(stages), workflow([...stages])).identical,
    ).toBe(true);
  });
});
