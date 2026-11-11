import { describe, expect, it } from 'vitest';

import { readBrowserScreenshot } from './browser-screenshot.reader';

describe('readBrowserScreenshot', () => {
  it.each([
    [
      { tab: 't1' },
      { kind: 'screenshot', tab: 't1', fullPage: false, view: false },
    ],
    [
      { tab: 't1', fullPage: true, view: true },
      { kind: 'screenshot', tab: 't1', fullPage: true, view: true },
    ],
    [
      { tab: 't1', width: 1440, height: 1280 },
      {
        kind: 'screenshot',
        tab: 't1',
        fullPage: false,
        view: false,
        width: 1440,
        height: 1280,
      },
    ],
  ])('reads %j into the operation main runs', (args, op) => {
    expect(readBrowserScreenshot(args)).toEqual({ ok: true, query: op });
  });

  it.each([
    {},
    { tab: 't1', fullPage: 'yes' },
    { tab: 't1', view: 'true' },
    { tab: 't1', width: 100 },
    { tab: 't1', width: 1440.5 },
    { tab: 't1', height: 99_999 },
  ])('refuses %j as malformed', (args) => {
    expect(readBrowserScreenshot(args)).toMatchObject({ ok: false });
  });
});
