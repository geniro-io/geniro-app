import { describe, expect, it } from 'vitest';

import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import { usageDimensions } from './usage-dimensions';

const run = (overrides: Partial<Run> = {}): Run =>
  ({
    id: 'run-a',
    workflowId: null,
    title: null,
    cwd: null,
    agentKind: null,
    model: null,
    ...overrides,
  }) as Run;

const node = (overrides: Partial<NodeState> = {}): NodeState =>
  ({
    runId: 'run-a',
    nodeId: 'main',
    agentKind: null,
    model: null,
    ...overrides,
  }) as NodeState;

describe('usageDimensions', () => {
  it('names the workflow a graph turn belonged to', () => {
    const dimensions = usageDimensions(
      run({ workflowId: 'nightly-review', title: 'Nightly review' }),
      node({ agentKind: 'claude' }),
    );

    expect(dimensions.workflowName).toBe('Nightly review');
  });

  it('leaves a single-agent chat out of the workflow breakdown', () => {
    // A CHAT carries a title too — its conversation name. Taking the title
    // unconditionally files every chat in the workflow breakdown under its own
    // heading, which is the one thing that breakdown must not contain, so the
    // gate is `workflowId` and never the title's presence.
    const dimensions = usageDimensions(
      run({ workflowId: null, title: 'Fix the login bug' }),
      null,
    );

    expect(dimensions.workflowName).toBeNull();
  });

  it('falls back to the slug when the run was never titled', () => {
    // Runs recorded before the executor stamped a title, and workflows whose
    // YAML names none. The slug is the file name, which is still a thing a
    // person can recognise.
    const dimensions = usageDimensions(
      run({ workflowId: 'nightly-review', title: null }),
      null,
    );

    expect(dimensions.workflowName).toBe('nightly-review');
  });

  it('prefers the NODE’s agent and model over the run’s', () => {
    // A workflow run names no single agent — its own `agentKind` is null and
    // each node names its own. Reading the run alone attributes every node's
    // spend to nothing.
    const dimensions = usageDimensions(
      run({ workflowId: 'w', agentKind: null, model: null, cwd: '/work' }),
      node({ agentKind: 'cursor-agent', model: 'auto' }),
    );

    expect(dimensions.agentKind).toBe('cursor-agent');
    expect(dimensions.model).toBe('auto');
    // `cwd` only ever lives on the run — `node_state` stamps none.
    expect(dimensions.cwd).toBe('/work');
  });

  it('answers for a run that is already gone', () => {
    // The backfill sweeps transcript rows whose run may have been deleted. Every
    // dimension is then unknown, which must be null rather than a throw.
    expect(usageDimensions(null, null)).toEqual({
      agentKind: null,
      model: null,
      cwd: null,
      workflowName: null,
    });
  });
});
