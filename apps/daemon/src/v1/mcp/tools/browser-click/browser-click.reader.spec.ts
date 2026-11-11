import { describe, expect, it } from 'vitest';

import { readBrowserClick } from './browser-click.reader';

describe('readBrowserClick', () => {
  it.each([
    [
      { tab: 't1', ref: 'e12' },
      { kind: 'click', tab: 't1', ref: 'e12' },
    ],
  ])('reads %j into the operation main runs', (args, op) => {
    expect(readBrowserClick(args)).toEqual({ ok: true, query: op });
  });

  it.each([{ tab: 't1' }, { ref: 'e1' }, { tab: 't1', ref: '' }])(
    'refuses %j as malformed',
    (args) => {
      expect(readBrowserClick(args)).toMatchObject({ ok: false });
    },
  );
});
