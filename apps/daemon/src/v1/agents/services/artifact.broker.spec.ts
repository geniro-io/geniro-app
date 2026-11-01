import { describe, expect, it } from 'vitest';

import { ArtifactBroker } from './artifact.broker';

describe('ArtifactBroker — the team-run mark', () => {
  it('holds until its own disposer runs', () => {
    const broker = new ArtifactBroker();
    expect(broker.inTeamRun('run-1')).toBe(false);
    const dispose = broker.markTeamRun('run-1');
    expect(broker.inTeamRun('run-1')).toBe(true);
    expect(broker.inTeamRun('run-2')).toBe(false);
    dispose();
    expect(broker.inTeamRun('run-1')).toBe(false);
  });

  it('a stale disposer leaves a newer mark of the same run in place', () => {
    const broker = new ArtifactBroker();
    const stale = broker.markTeamRun('run-1');
    const current = broker.markTeamRun('run-1');
    stale();
    expect(broker.inTeamRun('run-1')).toBe(true);
    current();
    expect(broker.inTeamRun('run-1')).toBe(false);
  });
});
