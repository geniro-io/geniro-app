import { describe, expect, it } from 'vitest';

import { readBrowserEvaluate } from './browser-evaluate.reader';

describe('readBrowserEvaluate', () => {
  it.each([
    [
      { tab: 't1', expression: ' document.title ' },
      { kind: 'evaluate', tab: 't1', expression: 'document.title' },
    ],
  ])('reads %j into the operation main runs', (args, op) => {
    expect(readBrowserEvaluate(args)).toEqual({ ok: true, query: op });
  });

  it.each([
    { tab: 't1' },
    { tab: 't1', expression: '  ' },
    { expression: '1' },
  ])('refuses %j as malformed', (args) => {
    expect(readBrowserEvaluate(args)).toMatchObject({ ok: false });
  });
});
