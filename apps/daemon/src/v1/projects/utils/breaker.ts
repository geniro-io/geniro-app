import { PROJECT_FAILURE_BREAKER_THRESHOLD } from '../projects.types';

/**
 * Whether a project has stopped picking work up.
 *
 * One function rather than the comparison written where it is needed, because
 * it is read from two modules — the queue that hands work out and the start
 * route that refuses it — and two spellings of "how many is too many" is how a
 * queue offering nothing comes to sit beside a route that accepts a start.
 */
export function isBreakerOpen(project: {
  autopilotFailureStreak: number;
}): boolean {
  return project.autopilotFailureStreak >= PROJECT_FAILURE_BREAKER_THRESHOLD;
}

/** The moment a project's wait on a spent usage limit ends, while it stands. */
export function limitHoldUntil(project: {
  autopilotLimitUntil: Date | null;
}): Date | null {
  const until = project.autopilotLimitUntil;
  return until !== null && until.getTime() > Date.now() ? until : null;
}
