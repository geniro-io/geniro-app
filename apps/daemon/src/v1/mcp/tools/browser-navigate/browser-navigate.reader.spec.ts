import { describe, expect, it } from 'vitest';

import { readBrowserNavigate } from './browser-navigate.reader';

describe('readBrowserNavigate', () => {
  it.each([
    [
      { tab: 't1', url: ' https://a.dev/x ' },
      { kind: 'navigate', tab: 't1', url: 'https://a.dev/x' },
    ],
  ])('reads %j into the operation main runs', (args, op) => {
    expect(readBrowserNavigate(args)).toEqual({ ok: true, query: op });
  });

  it.each([
    { url: 'https://a.dev' },
    { tab: '', url: 'https://a.dev' },
    { tab: 't1', url: '' },
    { tab: 't1' },
  ])('refuses %j as malformed', (args) => {
    expect(readBrowserNavigate(args)).toMatchObject({ ok: false });
  });
});
