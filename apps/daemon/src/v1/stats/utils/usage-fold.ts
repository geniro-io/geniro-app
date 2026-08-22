/**
 * The calendar arithmetic the per-day chart is keyed on.
 *
 * The FOLD itself — `emptyTotals` / `addUsage` / `usageFiguresFrom` — is not
 * here: it is shared with the per-chat metrics panel and lives in
 * `v1/agents/utils/usage-figures`. What is stats-specific is bucketing by day,
 * which nothing else in the daemon does.
 */

/**
 * The calendar day a moment falls on, in the machine's own timezone.
 *
 * TWIN PARSER: `localDayKey` in `apps/ui/src/renderer/stats/stats-format.ts`.
 * The two must agree on which day a moment falls on, and there is no shared
 * type spanning them — a change here MUST be mirrored there.
 *
 * Local rather than UTC because the daemon and the window reading it are the
 * same computer: "today" means the user's today, and a UTC key would file a
 * late-evening turn under tomorrow for everyone east of Greenwich and under
 * yesterday for everyone west of it.
 */
export function localDateKey(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, '0');
  const day = `${at.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Every calendar day the half-open range touches, oldest first.
 *
 * The chart needs a continuous axis: a period whose quiet days were simply
 * absent would draw them as though the busy days were adjacent, compressing a
 * fortnight of sporadic work into a solid week of activity.
 *
 * Stepped with `setDate` so it walks LOCAL days — across a daylight-saving
 * boundary a day is 23 or 25 hours, and adding a fixed 86,400,000 ms would
 * eventually skip or repeat one.
 */
export function eachLocalDay(from: Date, to: Date): string[] {
  // A range with no duration touches no day. Without this the walk starts at
  // the local midnight BEFORE `from`, which is earlier than `from` itself, so
  // an empty range would still emit the day it began on.
  if (from.getTime() >= to.getTime()) {
    return [];
  }
  const days: string[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (cursor.getTime() < to.getTime()) {
    days.push(localDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}
