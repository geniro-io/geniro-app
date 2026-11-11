import { describe, expect, it } from 'vitest';

import { readBrowserSelect } from './browser-select.reader';

describe('readBrowserSelect', () => {
  it.each([
    [
      { tab: 't1', ref: 'e4', values: ['de', 'fr'] },
      { kind: 'select', tab: 't1', ref: 'e4', values: ['de', 'fr'] },
    ],
  ])('reads %j into the operation main runs', (args, op) => {
    expect(readBrowserSelect(args)).toEqual({ ok: true, query: op });
  });

  it.each([
    { tab: 't1', ref: 'e4' },
    { tab: 't1', ref: 'e4', values: [] },
    { tab: 't1', ref: 'e4', values: 'de' },
  ])('refuses %j as malformed', (args) => {
    expect(readBrowserSelect(args)).toMatchObject({ ok: false });
  });
});
