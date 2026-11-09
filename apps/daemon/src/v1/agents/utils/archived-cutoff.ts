const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant a chat must have been archived at or before to be `olderThanDays`
 * days on the shelf, as of `now`.
 *
 * Fixed 24h rather than calendar days, deliberately: the window is a DURATION
 * somebody chose ("keep them a month"), not a date boundary, so a chat archived
 * at 09:00 is swept at 09:00 thirty days later whatever daylight saving did in
 * between. A calendar-day reading would make the same setting delete an hour
 * early or late twice a year, on rows nobody can get back.
 */
export function archivedCutoff(olderThanDays: number, now: Date): Date {
  return new Date(now.getTime() - olderThanDays * DAY_MS);
}
