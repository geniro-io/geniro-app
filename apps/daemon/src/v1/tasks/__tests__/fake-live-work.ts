import { Subject } from 'rxjs';

import type { RunLiveWork } from '../../agents/services/run-live-work.service';

/**
 * A `RunLiveWork` whose holds the spec sets: `hold` makes a run held by the
 * named work, `release` lets it go and announces the change.
 */
export function fakeLiveWork(): {
  liveWork: RunLiveWork;
  hold: (runId: string, name: string) => void;
  release: (runId: string) => void;
} {
  const held = new Map<string, string>();
  const changes = new Subject<string>();
  return {
    liveWork: {
      heldBy: (runId: string) => held.get(runId) ?? null,
      changes: () => changes.asObservable(),
    } as unknown as RunLiveWork,
    hold: (runId, name) => {
      held.set(runId, name);
    },
    release: (runId) => {
      held.delete(runId);
      changes.next(runId);
    },
  };
}
