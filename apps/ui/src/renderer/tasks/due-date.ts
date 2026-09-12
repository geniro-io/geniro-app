/**
 * How a due date reads on a card, and whether it is late.
 *
 * Compared as CALENDAR DAYS in the reader's own zone, never as instants: a task
 * due today is not overdue at 23:00, and `Date.parse('2026-09-30')` is UTC
 * midnight, which is already yesterday for anyone west of Greenwich. Both sides
 * are reduced to a local Y-M-D before they meet.
 */
export interface DueDateView {
  label: string;
  overdue: boolean;
  dueToday: boolean;
}

function localToday(now: Date): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function dueDateView(
  dueDate: string | null,
  now: Date = new Date(),
): DueDateView | null {
  if (dueDate === null) {
    return null;
  }
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
  if (parts === null) {
    return null;
  }
  const today = localToday(now);
  const [, year, month, day] = parts;
  // String comparison, not date arithmetic: `YYYY-MM-DD` sorts
  // lexicographically in calendar order, so this is the whole comparison and it
  // cannot drift by a zone.
  const overdue = dueDate < today;
  const dueToday = dueDate === today;

  if (dueToday) {
    return { label: 'Today', overdue: false, dueToday: true };
  }
  const monthName = MONTHS[Number(month) - 1] ?? month;
  const sameYear = year === today.slice(0, 4);
  const label = sameYear
    ? `${monthName} ${Number(day)}`
    : `${monthName} ${Number(day)}, ${year}`;
  return { label, overdue, dueToday: false };
}

/**
 * A card-footer date: `Aug 19`, with the year only when it is not this one.
 *
 * Absolute rather than relative, unlike the detail panel's `formatRelativeTime`
 * — Linear's board card is the reference and it states the date, which is what
 * a footer is for: a fact to place the card by, not a clock to read. "3 months
 * ago" gives the eye nothing to sort on.
 */
export function shortDate(iso: string, now: Date = new Date()): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return null;
  }
  const month = MONTHS[at.getMonth()] ?? '';
  const day = at.getDate();
  return at.getFullYear() === now.getFullYear()
    ? `${month} ${day}`
    : `${month} ${day}, ${at.getFullYear()}`;
}
