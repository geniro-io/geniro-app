import { describe, expect, it } from 'vitest';

import { readBrowserSnapshot } from './browser-snapshot.reader';

describe('readBrowserSnapshot', () => {
  it.each([[{ tab: 't2' }, { kind: 'snapshot', tab: 't2' }]])(
    'reads %j into the operation main runs',
    (args, op) => {
      expect(readBrowserSnapshot(args)).toEqual({ ok: true, query: op });
    },
  );

  it.each([{}, { tab: ' ' }, { tab: 't1', ref: 'e1' }])(
    'refuses %j as malformed',
    (args) => {
      expect(readBrowserSnapshot(args)).toMatchObject({ ok: false });
    },
  );
});
