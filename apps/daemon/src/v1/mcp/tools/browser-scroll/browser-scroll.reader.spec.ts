import { describe, expect, it } from 'vitest';

import { readBrowserScroll } from './browser-scroll.reader';

describe('readBrowserScroll', () => {
  it.each([
    [{ tab: 't1' }, { kind: 'scroll', tab: 't1' }],
    [
      { tab: 't1', ref: 'e2', dy: -300 },
      { kind: 'scroll', tab: 't1', ref: 'e2', dy: -300 },
    ],
  ])('reads %j into the operation main runs', (args, op) => {
    expect(readBrowserScroll(args)).toEqual({ ok: true, query: op });
  });

  it.each([{}, { tab: 't1', dy: 'far' }, { tab: 't1', dy: 1e9 }])(
    'refuses %j as malformed',
    (args) => {
      expect(readBrowserScroll(args)).toMatchObject({ ok: false });
    },
  );
});
