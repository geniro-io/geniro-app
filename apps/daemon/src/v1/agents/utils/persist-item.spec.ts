import { describe, expect, it } from 'vitest';

import { Run } from '../../runs/entity/run.entity';
import { runToWire } from './persist-item';

/**
 * The PRODUCER hop of the run row's wire projection.
 *
 * `archivedAt` crosses the daemon→renderer seam, where the rule is a test at
 * every hop; the reader's own is `Chats.spec.tsx`'s "an archived thread's
 * composer is disabled", which drives the field off the row. Two tests rather
 * than one so reverting either is not masked by the other passing.
 */
describe('runToWire', () => {
  it("projects an archived run's archivedAt as an ISO string", () => {
    const run = new Run();
    run.archivedAt = new Date('2026-08-30T12:34:56.000Z');

    expect(runToWire(run).archivedAt).toBe('2026-08-30T12:34:56.000Z');
  });

  it('projects a run that was never archived as null', () => {
    expect(runToWire(new Run()).archivedAt).toBeNull();
  });
});
