import { describe, expect, it } from 'vitest';

import { dueDateView } from './due-date';

/** A local-time instant, so the tests read in the same frame the code works in. */
const at = (iso: string): Date => new Date(iso);

describe('dueDateView', () => {
  it('has nothing to say for a task with no due date', () => {
    expect(dueDateView(null)).toBeNull();
  });

  it('calls today "Today" rather than printing the date', () => {
    expect(dueDateView('2026-09-30', at('2026-09-30T09:00:00'))).toEqual({
      label: 'Today',
      overdue: false,
      dueToday: true,
    });
  });

  it('does not call a task due today overdue late in the evening', () => {
    // Pins that "due today" wins over any overdue reading, whatever the clock
    // says. It is NOT the test that catches a zone bug — the `dueToday` branch
    // returns `overdue: false` outright, so it would pass over a broken
    // comparison too. The boundary test below is the one that catches that.
    const view = dueDateView('2026-09-30', at('2026-09-30T23:59:00'));

    expect(view?.overdue).toBe(false);
    expect(view?.dueToday).toBe(true);
  });

  it('is overdue only once the day has actually passed', () => {
    // THE zone test. Comparing a `YYYY-MM-DD` as an instant makes
    // `Date.parse('2026-09-29')` UTC midnight, which is already past for a
    // reader west of Greenwich — verified: swapping the string comparison for
    // `Date.parse(dueDate) < now.getTime()` fails this and nothing else.
    expect(dueDateView('2026-09-29', at('2026-09-30T00:01:00'))?.overdue).toBe(
      true,
    );
    expect(dueDateView('2026-10-01', at('2026-09-30T23:59:00'))?.overdue).toBe(
      false,
    );
  });

  it('drops the year within this year and keeps it across one', () => {
    expect(dueDateView('2026-10-05', at('2026-09-30T09:00:00'))?.label).toBe(
      'Oct 5',
    );
    expect(dueDateView('2027-01-05', at('2026-09-30T09:00:00'))?.label).toBe(
      'Jan 5, 2027',
    );
  });

  it('says nothing rather than guessing at a value that is not a date', () => {
    // The daemon validates the shape, so this is defence against a build skew
    // rather than routine input — and the wrong answer here would be a card
    // showing "NaN" or "Invalid Date".
    expect(dueDateView('soon')).toBeNull();
    expect(dueDateView('2026-9-3')).toBeNull();
    expect(dueDateView('')).toBeNull();
  });
});
