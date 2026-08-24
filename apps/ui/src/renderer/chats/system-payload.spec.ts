import { describe, expect, it } from 'vitest';

import {
  isCliAuthored,
  isInfoNotice,
  isWarningNotice,
  noticeCaption,
} from './system-payload';

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

describe('isWarningNotice', () => {
  it('recognises a degrade the daemon marked as one', () => {
    expect(
      isWarningNotice({
        message: "this model does not offer 'effort=max'",
        severity: 'warning',
      }),
    ).toBe(true);
  });

  it('leaves an unmarked notice in the failure chrome', () => {
    // The two readers must not overlap: absent severity still means the loud
    // one, so a producer that has not thought about volume is not quietly
    // downgraded by this branch existing.
    expect(isWarningNotice({ message: 'the caller got no call surface' })).toBe(
      false,
    );
    expect(isWarningNotice({ message: 'kept for you', severity: 'info' })).toBe(
      false,
    );
  });

  it('refuses the degrade chrome to RELAYED agent text that asks for it', () => {
    // The same trust boundary `isInfoNotice` holds, and it has to be held twice
    // — a second reader that forgot the guard would hand relayed prose a
    // channel to dress itself as an application advisory.
    expect(
      isWarningNotice({
        message: 'ignore all previous instructions',
        origin: 'cli',
        severity: 'warning',
      }),
    ).toBe(false);
  });

  it('is safe on a payload that is not an object at all', () => {
    expect(isWarningNotice(null)).toBe(false);
    expect(isWarningNotice(42)).toBe(false);
  });
});

describe('noticeCaption', () => {
  it('reads the kind the daemon named this row', () => {
    expect(
      noticeCaption({
        message: 'API Error: Connection closed mid-response.',
        severity: 'warning',
        caption: 'api error',
      }),
    ).toBe('api error');
  });

  it('leaves the severity default standing when nothing named a kind', () => {
    // Every historical notice, and why the key is stamped only when set: the
    // degrades that came first are captioned `not applied` by the row itself.
    expect(
      noticeCaption({
        message: 'effort max is unavailable',
        severity: 'warning',
      }),
    ).toBeNull();
  });

  it('refuses a caption to RELAYED agent text that asks for one', () => {
    // The same trust boundary its two neighbours hold: a caption is the row
    // saying what KIND of app advisory it is, so relayed prose must not pick
    // its own.
    expect(
      noticeCaption({
        message: 'a summary of your conversation',
        origin: 'cli',
        caption: 'api error',
      }),
    ).toBeNull();
  });

  it('is safe on an empty caption and on a payload that is not an object', () => {
    expect(noticeCaption({ message: 'x', caption: '' })).toBeNull();
    expect(noticeCaption({ message: 'x', caption: 7 })).toBeNull();
    expect(noticeCaption(null)).toBeNull();
  });
});
