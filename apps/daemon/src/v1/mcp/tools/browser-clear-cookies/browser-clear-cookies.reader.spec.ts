import { describe, expect, it } from 'vitest';

import { readBrowserClearCookies } from './browser-clear-cookies.reader';

describe('readBrowserClearCookies', () => {
  it.each([
    [{}, { kind: 'clearCookies' }],
    [
      { domain: 'a.dev', tab: 't2' },
      { kind: 'clearCookies', tab: 't2', domain: 'a.dev' },
    ],
  ])('reads %j into the operation main runs', (args, op) => {
    expect(readBrowserClearCookies(args)).toEqual({ ok: true, query: op });
  });

  it.each([{ domain: '' }, { tab: '' }, { all: true }])(
    'refuses %j as malformed',
    (args) => {
      expect(readBrowserClearCookies(args)).toMatchObject({ ok: false });
    },
  );
});
