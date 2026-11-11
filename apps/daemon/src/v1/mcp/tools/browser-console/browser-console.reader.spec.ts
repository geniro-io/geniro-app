import { describe, expect, it } from 'vitest';

import { readBrowserConsole } from './browser-console.reader';

describe('readBrowserConsole', () => {
  it.each([[{ tab: 't1' }, { kind: 'console', tab: 't1' }]])(
    'reads %j into the operation main runs',
    (args, op) => {
      expect(readBrowserConsole(args)).toEqual({ ok: true, query: op });
    },
  );

  it.each([{}, { tab: '' }])('refuses %j as malformed', (args) => {
    expect(readBrowserConsole(args)).toMatchObject({ ok: false });
  });
});
