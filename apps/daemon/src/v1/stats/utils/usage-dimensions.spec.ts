import { describe, expect, it } from 'vitest';

import { workflowSnapshotOf } from '../../graphs/utils/workflow-snapshot';
import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import { reportedModelOf, usageDimensions } from './usage-dimensions';

const run = (overrides: Partial<Run> = {}): Run =>
  ({
    id: 'run-a',
    workflowId: null,
    workflowSnapshot: null,
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

/** The copy a workflow run keeps, written by the executor's own writer. */
const snapshotNamed = (name: string): string =>
  workflowSnapshotOf({ name, nodes: [], edges: [] });

describe('usageDimensions', () => {
  it('names the workflow from the run’s own snapshot, never its title', () => {
    // A workflow run is titled after its CONVERSATION now, like a chat. Read
    // from the title, one workflow's spend split into a row per task it was
    // ever run on — the breakdown named what each run was ABOUT.
    const dimensions = usageDimensions(
      run({
        workflowId: 'nightly-review',
        title: 'Fix the flaky login test',
        workflowSnapshot: snapshotNamed('Nightly review'),
      }),
      node({ agentKind: 'claude' }),
    );

    expect(dimensions.workflowName).toBe('Nightly review');
  });

  it('files every run of one workflow under one name, however each is titled', () => {
    const snapshot = snapshotNamed('Nightly review');
    const names = [
      run({
        workflowId: 'nightly-review',
        title: null,
        workflowSnapshot: snapshot,
      }),
      run({
        workflowId: 'nightly-review',
        title: 'Bump the SDK',
        workflowSnapshot: snapshot,
      }),
    ].map((one) => usageDimensions(one, null).workflowName);

    // The FIRST turns of a run land before the run is named, and must not
    // fall through to the slug — one workflow, two keys, within one run.
    expect(names).toEqual(['Nightly review', 'Nightly review']);
  });

  it('files a turn under the pool member its own row names over its node’s stamp', () => {
    // A pooled node is stamped with member 1; a call another member ran says so
    // on its usage rows, and its spend belongs to that CLI and that model.
    const member1 = {
      agentKind: 'claude',
      model: 'opus',
    } as unknown as NodeState;
    const dimensions = usageDimensions(
      run({ workflowId: 'team' }),
      member1,
      null,
      { agentKind: AgentKind.Codex, model: 'gpt-5.5' },
    );
    expect(dimensions).toMatchObject({ agentKind: 'codex', model: 'gpt-5.5' });
    // A member on its CLI's default model is filed under no model — never
    // under member 1's — unless the CLI reported the one it ran.
    expect(
      usageDimensions(run({ workflowId: 'team' }), member1, null, {
        agentKind: AgentKind.Codex,
        model: null,
      }).model,
    ).toBeNull();
    expect(
      usageDimensions(run({ workflowId: 'team' }), member1, 'gpt-5.6', {
        agentKind: AgentKind.Codex,
        model: null,
      }).model,
    ).toBe('gpt-5.6');
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

  it('falls back to the slug when the run holds no snapshot — not to its title', () => {
    // A run made before snapshots existed carries none until something first
    // reads its graph. The slug is the file name, which is still a thing a
    // person can recognise; the title would be the conversation's.
    const dimensions = usageDimensions(
      run({ workflowId: 'nightly-review', title: 'Fix the login bug' }),
      null,
    );

    expect(dimensions.workflowName).toBe('nightly-review');
  });

  it('falls back to the slug when the snapshot cannot be read', () => {
    const dimensions = usageDimensions(
      run({ workflowId: 'nightly-review', workflowSnapshot: 'not json {' }),
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

  it('files a turn under the model the CLI REPORTED, over the one it was asked for', () => {
    // A run that leaves the choice to the CLI names no model, which filed real
    // spend under a "CLI default" row naming none; and an alias (`opus`) splits
    // one model across two rows.
    expect(
      usageDimensions(
        run({ model: null }),
        null,
        reportedModelOf({ usage: { contextModel: 'claude-opus-5-5' } }),
      ).model,
    ).toBe('claude-opus-5-5');
    expect(
      usageDimensions(run({ model: 'opus' }), null, 'claude-opus-5-5').model,
    ).toBe('claude-opus-5-5');
    // Nothing reported: the setting is all there is.
    expect(usageDimensions(run({ model: 'opus' }), null, null).model).toBe(
      'opus',
    );
  });

  it('reads no reported model from a payload that names none', () => {
    expect(reportedModelOf({ usage: { contextModel: '' } })).toBeNull();
    expect(reportedModelOf({ usage: {} })).toBeNull();
    expect(reportedModelOf(null)).toBeNull();
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
