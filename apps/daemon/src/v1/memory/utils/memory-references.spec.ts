import { describe, expect, it } from 'vitest';

import {
  REFERENCED_PATHS_MAX,
  referencedPathsOf,
  STATES_RULE_BODY_CHARS,
  statesRule,
} from './memory-references';

describe('statesRule', () => {
  it.each([
    ['Never commit secrets.'],
    ['You must not push to main.'],
    ['This path is forbidden.'],
    ['Нельзя коммитить секреты.'],
    ['Никогда не запускай colima.'],
    ['Запрещено править сгенерированный клиент.'],
  ])('reads a limit in %j', (body) => {
    expect(statesRule('Rule', body)).toBe(true);
  });

  it('reads a limit in the title too', () => {
    expect(statesRule('Never restart colima', 'Shared daemon.')).toBe(true);
  });

  it('does not read a rule word inside a longer word', () => {
    expect(statesRule('Notes', 'nevertheless the cache stays warm.')).toBe(
      false,
    );
  });

  it('reads only the first 200 characters of the body', () => {
    expect(
      statesRule('Notes', 'x'.repeat(STATES_RULE_BODY_CHARS) + ' never'),
    ).toBe(false);
    expect(
      statesRule('Notes', 'x'.repeat(STATES_RULE_BODY_CHARS - 10) + ' never'),
    ).toBe(true);
  });
});

describe('referencedPathsOf', () => {
  it('finds repo paths with a slash and an extension, a line number stripped', () => {
    expect(
      referencedPathsOf(
        'Layout',
        'See apps/x/y.ts and `.claude/rules/a.md` and docs/a.md:12.',
      ),
    ).toEqual(['apps/x/y.ts', '.claude/rules/a.md', 'docs/a.md']);
  });

  it('reads the title as well as the body', () => {
    expect(referencedPathsOf('apps/title.ts', 'no path here')).toEqual([
      'apps/title.ts',
    ]);
  });

  it('leaves out URLs, absolute and home paths, and paths that climb out', () => {
    expect(
      referencedPathsOf(
        'Refs',
        'https://x.com/a/b.ts /abs/p.ts ~/h/x.ts ../up/x.ts github.com/a/b.md',
      ),
    ).toEqual([]);
  });

  it('leaves out a bare directory, which has no extension', () => {
    expect(referencedPathsOf('Dir', 'Everything under apps/daemon.')).toEqual(
      [],
    );
  });

  it('strips the trailing period of a path that ends a sentence', () => {
    expect(referencedPathsOf('', 'Edit apps/x/y.ts.')).toEqual(['apps/x/y.ts']);
  });

  it('keeps at most REFERENCED_PATHS_MAX paths', () => {
    const body = Array.from(
      { length: REFERENCED_PATHS_MAX + 5 },
      (_, n) => `dir${n}/file.ts`,
    ).join(' ');

    expect(referencedPathsOf('', body)).toHaveLength(REFERENCED_PATHS_MAX);
  });
});
