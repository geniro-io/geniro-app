import type { RunPlacement, RunProjectFacts } from '../projects.types';

/**
 * The facts a new run's other snapshots (its memory index) resolve its project
 * from: the project already settled for it, so both follow one answer — or,
 * when that could not be read, the facts as given.
 */
export function placedFacts<T extends RunProjectFacts>(
  facts: T,
  placement: RunPlacement,
): T {
  return placement.source === null
    ? facts
    : { ...facts, projectId: placement.projectId };
}
