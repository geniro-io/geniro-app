import { describe, expect, it } from 'vitest';

import { ArtifactBroker } from './artifact.broker';

describe('ArtifactBroker — the workflow-run mark', () => {
  it('holds until its own disposer runs', () => {
    const broker = new ArtifactBroker();
    expect(broker.inWorkflowRun('run-1')).toBe(false);
    const dispose = broker.markWorkflowRun('run-1');
    expect(broker.inWorkflowRun('run-1')).toBe(true);
    expect(broker.inWorkflowRun('run-2')).toBe(false);
    dispose();
    expect(broker.inWorkflowRun('run-1')).toBe(false);
  });

  it('a stale disposer leaves a newer mark of the same run in place', () => {
    const broker = new ArtifactBroker();
    const stale = broker.markWorkflowRun('run-1');
    const current = broker.markWorkflowRun('run-1');
    stale();
    expect(broker.inWorkflowRun('run-1')).toBe(true);
    current();
    expect(broker.inWorkflowRun('run-1')).toBe(false);
  });
});
