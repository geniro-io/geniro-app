import { describe, expect, it } from 'vitest';

import { resetInstantFrom } from './reset-instant';

const at = (iso: string): Date => new Date(iso);
const iso = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

describe('resetInstantFrom', () => {
  it('reads the sentence from the reported run — a time today, in its own zone', () => {
    // `You've hit your session limit · resets 6:10pm (Asia/Almaty)`, seen at
    // 11:36 UTC: Almaty is UTC+5, so the window reopened at 13:10 UTC.
    expect(
      iso(resetInstantFrom('6:10pm (Asia/Almaty)', at('2026-09-22T11:36:06Z'))),
    ).toBe('2026-09-22T13:10:00.000Z');
  });

  it('reads an on-the-hour time, which claude prints without minutes', () => {
    expect(iso(resetInstantFrom('6pm (UTC)', at('2026-09-22T11:00:00Z')))).toBe(
      '2026-09-22T18:00:00.000Z',
    );
  });

  it('takes a time already past today as TOMORROW', () => {
    expect(iso(resetInstantFrom('6pm (UTC)', at('2026-09-22T19:00:00Z')))).toBe(
      '2026-09-23T18:00:00.000Z',
    );
  });

  it('reads a dated reset, and a zone behind UTC', () => {
    // Pacific daylight time on Sep 25 is UTC-7.
    expect(
      iso(
        resetInstantFrom(
          'Sep 25, 3pm (America/Los_Angeles)',
          at('2026-09-22T11:00:00Z'),
        ),
      ),
    ).toBe('2026-09-25T22:00:00.000Z');
  });

  it('reads a dated reset that carries its year', () => {
    expect(
      iso(
        resetInstantFrom('Jan 2, 2027, 9:30am (UTC)', at('2026-12-30T10:00Z')),
      ),
    ).toBe('2027-01-02T09:30:00.000Z');
  });

  it('rolls a year-less date that has already passed into next year', () => {
    expect(
      iso(resetInstantFrom('Jan 2, 9am (UTC)', at('2026-12-30T10:00:00Z'))),
    ).toBe('2027-01-02T09:00:00.000Z');
  });

  it('crosses a DST change onto the right side of it', () => {
    // Europe/Berlin leaves summer time on 2026-10-25: 9am that day is UTC+1.
    expect(
      iso(
        resetInstantFrom(
          'Oct 25, 9am (Europe/Berlin)',
          at('2026-10-20T10:00Z'),
        ),
      ),
    ).toBe('2026-10-25T08:00:00.000Z');
  });

  it('answers null for anything it cannot place exactly', () => {
    const now = at('2026-09-22T11:00:00Z');
    expect(resetInstantFrom('soon', now)).toBeNull();
    expect(resetInstantFrom('in 3 hours', now)).toBeNull();
    expect(resetInstantFrom('13pm (UTC)', now)).toBeNull();
    expect(resetInstantFrom('6pm (Not/AZone)', now)).toBeNull();
  });
});
