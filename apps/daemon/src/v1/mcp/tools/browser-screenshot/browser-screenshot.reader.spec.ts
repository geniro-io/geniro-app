import { describe, expect, it } from 'vitest';

import { readBrowserScreenshot } from './browser-screenshot.reader';

describe('readBrowserScreenshot', () => {
  it.each([
    [{ tab: 't1' }, { kind: 'screenshot', tab: 't1', fullPage: false }],
    [
      { tab: 't1', fullPage: true },
      { kind: 'screenshot', tab: 't1', fullPage: true },
    ],
  ])('reads %j into the operation main runs', (args, op) => {
    expect(readBrowserScreenshot(args)).toEqual({ ok: true, query: op });
  });

  it.each([{}, { tab: 't1', fullPage: 'yes' }])(
    'refuses %j as malformed',
    (args) => {
      expect(readBrowserScreenshot(args)).toMatchObject({ ok: false });
    },
  );
});
