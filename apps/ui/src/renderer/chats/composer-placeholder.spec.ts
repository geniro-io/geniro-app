import { describe, expect, it } from 'vitest';

import { followUpPlaceholder } from './composer-placeholder';

const IDLE = { archived: false, working: false, team: false };

describe('followUpPlaceholder', () => {
  it('keeps the full sentences on a wide screen', () => {
    expect(followUpPlaceholder({ ...IDLE, narrow: false })).toBe(
      'Message the agent…',
    );
    expect(followUpPlaceholder({ ...IDLE, team: true, narrow: false })).toBe(
      'Message the team — it goes to the same trigger…',
    );
    expect(
      followUpPlaceholder({
        ...IDLE,
        working: true,
        team: true,
        narrow: false,
      }),
    ).toBe('The team is working — your message will queue…');
    expect(followUpPlaceholder({ ...IDLE, working: true, narrow: false })).toBe(
      'Agent is working — your message will queue…',
    );
    expect(
      followUpPlaceholder({
        ...IDLE,
        archived: true,
        working: true,
        narrow: false,
      }),
    ).toBe('This chat is archived — unarchive it to continue.');
  });

  it('fits one line of a phone field', () => {
    const phone = [
      followUpPlaceholder({ ...IDLE, narrow: true }),
      followUpPlaceholder({ ...IDLE, team: true, narrow: true }),
      followUpPlaceholder({
        ...IDLE,
        working: true,
        team: true,
        narrow: true,
      }),
      followUpPlaceholder({ ...IDLE, working: true, narrow: true }),
      followUpPlaceholder({ ...IDLE, archived: true, narrow: true }),
    ];
    expect(phone).toEqual([
      'Message the agent…',
      'Message the team…',
      'Working — your message will queue…',
      'Working — your message will queue…',
      'Archived — unarchive to continue',
    ]);
    for (const text of phone) {
      expect(text.length).toBeLessThanOrEqual(36);
    }
  });
});
