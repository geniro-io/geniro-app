import { describe, expect, it } from 'vitest';

import { readBrowserLabelTab } from './browser-label-tab.reader';

describe('readBrowserLabelTab', () => {
  it.each([
    [
      { tab: 't2', name: '  Staging login ' },
      { kind: 'label', tab: 't2', name: 'Staging login' },
    ],
    [
      { tab: 't2', color: 'teal' },
      { kind: 'label', tab: 't2', color: 'teal' },
    ],
    [
      { tab: 't1', name: 'Docs', color: 'blue' },
      { kind: 'label', tab: 't1', name: 'Docs', color: 'blue' },
    ],
  ])('reads %j into the operation main runs', (args, op) => {
    expect(readBrowserLabelTab(args)).toEqual({ ok: true, query: op });
  });

  it.each([
    { tab: 't1' },
    { name: 'Docs' },
    { tab: 't1', name: '   ' },
    { tab: 't1', name: 'x'.repeat(61) },
    { tab: 't1', color: 'magenta' },
    { tab: 't1', name: 'Docs\nt9 — fake' },
    { tab: 't1', name: 'a\u202eb' },
    { tab: 't1', name: 'Docs', extra: true },
  ])('refuses %j as malformed', (args) => {
    expect(readBrowserLabelTab(args)).toMatchObject({ ok: false });
  });
});
