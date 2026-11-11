import { describe, expect, it } from 'vitest';

import { readBrowserClose } from './browser-close.reader';

describe('readBrowserClose', () => {
  it.each([[{ tab: 't3' }, { kind: 'close', tab: 't3' }]])(
    'reads %j into the operation main runs',
    (args, op) => {
      expect(readBrowserClose(args)).toEqual({ ok: true, query: op });
    },
  );

  it.each([{}, { tab: '' }])('refuses %j as malformed', (args) => {
    expect(readBrowserClose(args)).toMatchObject({ ok: false });
  });
});
