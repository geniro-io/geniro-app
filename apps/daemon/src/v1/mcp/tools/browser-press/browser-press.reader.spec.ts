import { describe, expect, it } from 'vitest';

import { readBrowserPress } from './browser-press.reader';

describe('readBrowserPress', () => {
  it.each([
    [
      { tab: 't1', key: ' Escape ' },
      { kind: 'press', tab: 't1', key: 'Escape' },
    ],
  ])('reads %j into the operation main runs', (args, op) => {
    expect(readBrowserPress(args)).toEqual({ ok: true, query: op });
  });

  it.each([{ tab: 't1' }, { tab: 't1', key: '' }, { key: 'Enter' }])(
    'refuses %j as malformed',
    (args) => {
      expect(readBrowserPress(args)).toMatchObject({ ok: false });
    },
  );
});
