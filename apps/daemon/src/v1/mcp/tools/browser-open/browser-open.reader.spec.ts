import { describe, expect, it } from 'vitest';

import { readBrowserOpen } from './browser-open.reader';

describe('readBrowserOpen', () => {
  it.each([
    [
      { url: ' http://localhost:5173/login ' },
      { kind: 'open', url: 'http://localhost:5173/login' },
    ],
    [
      {
        url: 'https://staging.acme.dev',
        ownCookies: {
          label: 'admin',
          cookies: [{ name: 'sid', value: 'abc', domain: 'staging.acme.dev' }],
        },
      },
      {
        kind: 'open',
        url: 'https://staging.acme.dev',
        ownCookies: {
          label: 'admin',
          cookies: [{ name: 'sid', value: 'abc', domain: 'staging.acme.dev' }],
        },
      },
    ],
  ])('reads %j into the operation main runs', (args, op) => {
    expect(readBrowserOpen(args)).toEqual({ ok: true, query: op });
  });

  it.each([
    {},
    { url: '   ' },
    { url: 'https://a.dev', ownCookies: { cookies: [] } },
    {
      url: 'https://a.dev',
      ownCookies: { label: 'x', cookies: [{ name: 'sid', value: 'v' }] },
    },
    { url: 'https://a.dev', extra: true },
  ])('refuses %j as malformed', (args) => {
    expect(readBrowserOpen(args)).toMatchObject({ ok: false });
  });
});
