import { describe, expect, it } from 'vitest';

import { readBrowserType } from './browser-type.reader';

describe('readBrowserType', () => {
  it.each([
    [
      { tab: 't1', ref: 'e3', text: 'hello' },
      { kind: 'type', tab: 't1', ref: 'e3', text: 'hello', submit: false },
    ],
    [
      { tab: 't1', ref: 'e3', text: '', submit: true },
      { kind: 'type', tab: 't1', ref: 'e3', text: '', submit: true },
    ],
  ])('reads %j into the operation main runs', (args, op) => {
    expect(readBrowserType(args)).toEqual({ ok: true, query: op });
  });

  it.each([
    { tab: 't1', ref: 'e3' },
    { tab: 't1', text: 'x' },
    { tab: 't1', ref: 'e3', text: 5 },
  ])('refuses %j as malformed', (args) => {
    expect(readBrowserType(args)).toMatchObject({ ok: false });
  });
});
