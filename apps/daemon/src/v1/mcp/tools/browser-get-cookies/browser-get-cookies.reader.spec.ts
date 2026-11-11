import { describe, expect, it } from 'vitest';

import { readBrowserGetCookies } from './browser-get-cookies.reader';

describe('readBrowserGetCookies', () => {
  it.each([
    [{}, { kind: 'getCookies' }],
    [
      { url: 'https://a.dev', tab: 't2' },
      { kind: 'getCookies', tab: 't2', url: 'https://a.dev' },
    ],
  ])('reads %j into the operation main runs', (args, op) => {
    expect(readBrowserGetCookies(args)).toEqual({ ok: true, query: op });
  });

  it.each([{ url: '' }, { tab: '' }, { value: true }])(
    'refuses %j as malformed',
    (args) => {
      expect(readBrowserGetCookies(args)).toMatchObject({ ok: false });
    },
  );
});
