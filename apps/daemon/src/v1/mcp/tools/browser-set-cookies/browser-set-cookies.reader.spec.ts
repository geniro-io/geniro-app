import { describe, expect, it } from 'vitest';

import { readBrowserSetCookies } from './browser-set-cookies.reader';

describe('readBrowserSetCookies', () => {
  it.each([
    [
      { cookies: [{ name: 'sid', value: 'abc', url: 'https://a.dev' }] },
      {
        kind: 'setCookies',
        cookies: [{ name: 'sid', value: 'abc', url: 'https://a.dev' }],
      },
    ],
    [
      {
        tab: 't2',
        cookies: [
          {
            name: 'k',
            value: '',
            domain: '.a.dev',
            sameSite: 'lax',
            expires: 1900000000,
            secure: true,
          },
        ],
      },
      {
        kind: 'setCookies',
        tab: 't2',
        cookies: [
          {
            name: 'k',
            value: '',
            domain: '.a.dev',
            sameSite: 'lax',
            expires: 1900000000,
            secure: true,
          },
        ],
      },
    ],
  ])('reads %j into the operation main runs', (args, op) => {
    expect(readBrowserSetCookies(args)).toEqual({ ok: true, query: op });
  });

  it.each([
    {},
    { cookies: [] },
    { cookies: [{ value: 'v', url: 'https://a.dev' }] },
    { cookies: [{ name: 'sid', url: 'https://a.dev' }] },
    { cookies: [{ name: 'sid', value: 5, url: 'https://a.dev' }] },
    { cookies: [{ name: 'sid', value: 'v' }] },
    {
      cookies: [
        {
          name: 'sid',
          value: 'v',
          url: 'https://a.dev',
          sameSite: 'sometimes',
        },
      ],
    },
    {
      cookies: [
        { name: 'sid', value: 'v', url: 'https://a.dev', expires: Infinity },
      ],
    },
    {
      cookies: [
        { name: 'sid', value: 'v', url: 'https://a.dev', expires: Number.NaN },
      ],
    },
  ])('refuses %j as malformed', (args) => {
    expect(readBrowserSetCookies(args)).toMatchObject({ ok: false });
  });
});
