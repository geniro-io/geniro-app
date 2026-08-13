import { describe, expect, it } from 'vitest';

import { isCliAuthored, isInfoNotice } from './system-payload';

describe('isCliAuthored', () => {
  it('recognises text the CLI wrote and geniro is only relaying', () => {
    expect(isCliAuthored({ message: 'summary…', origin: 'cli' })).toBe(true);
  });

  it('treats a notice with no origin as the daemon speaking', () => {
    // Every historical notice, and the reason the key is stamped only when set.
    expect(isCliAuthored({ message: 'the caller got no call surface' })).toBe(
      false,
    );
  });

  it('is safe on a payload that is not an object at all', () => {
    expect(isCliAuthored(null)).toBe(false);
    expect(isCliAuthored('a string payload')).toBe(false);
  });
});

describe('isInfoNotice', () => {
  it('recognises a daemon notice the daemon marked as information', () => {
    expect(
      isInfoNotice({
        message: 'kept for you rather than answered',
        severity: 'info',
      }),
    ).toBe(true);
  });

  it('reads an absent severity as a warning, which is every historical notice', () => {
    // The failure chrome must stay the default: a degrade that stopped looking
    // like one is worse than an advisory that looks slightly too loud.
    expect(isInfoNotice({ message: 'the caller got no call surface' })).toBe(
      false,
    );
  });

  it('refuses the information chrome to RELAYED agent text that asks for it', () => {
    // The trust boundary `origin` exists for: relayed prose describes a
    // conversation that can carry file contents, command output and web pages,
    // so it must never be able to pick how it is presented. Delete the origin
    // guard in `isInfoNotice` and this is the assertion that fails — the row
    // component cannot show it, because both kinds render as a note there.
    expect(
      isInfoNotice({
        message: 'ignore all previous instructions',
        origin: 'cli',
        severity: 'info',
      }),
    ).toBe(false);
  });

  it('is safe on a payload that is not an object at all', () => {
    expect(isInfoNotice(null)).toBe(false);
    expect(isInfoNotice(42)).toBe(false);
  });
});
