import { describe, expect, it } from 'vitest';

import { readBrowserTabs } from './browser-tabs.reader';

describe('readBrowserTabs', () => {
  it.each([[{}, { kind: 'tabs' }]])(
    'reads %j into the operation main runs',
    (args, op) => {
      expect(readBrowserTabs(args)).toEqual({ ok: true, query: op });
    },
  );

  it.each([{ tab: 't1' }])('refuses %j as malformed', (args) => {
    expect(readBrowserTabs(args)).toMatchObject({ ok: false });
  });
});
