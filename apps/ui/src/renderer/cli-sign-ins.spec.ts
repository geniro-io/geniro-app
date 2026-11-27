import { describe, expect, it } from 'vitest';

import { detection } from './__tests__/settings-attention-fixtures';
import { signedOutAccountRows, signedOutAccounts } from './cli-sign-ins';

describe('signedOutAccountRows', () => {
  it('lists a signed-out default account, then each signed-out configuration', () => {
    const claude = detection('claude', {
      loggedIn: false,
      profileLogins: { '/work': false, '/home': true, '/odd': null },
    });

    expect(signedOutAccountRows(claude)).toEqual([
      { kind: 'claude', configDir: null },
      { kind: 'claude', configDir: '/work' },
    ]);
    expect(signedOutAccounts(claude)).toBe(2);
  });

  it('lists nothing for a CLI that is not installed or whose answer is unknown', () => {
    expect(
      signedOutAccountRows(
        detection('claude', { found: false, loggedIn: false }),
      ),
    ).toEqual([]);
    expect(
      signedOutAccountRows(detection('codex', { loggedIn: null })),
    ).toEqual([]);
  });
});
