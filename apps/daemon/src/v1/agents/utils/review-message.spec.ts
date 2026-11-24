import { describe, expect, it } from 'vitest';

import { composeReviewText, snapshotOf } from './review-message';

const HEADER_ONE =
  'Review of your changes — 3 comments in 2 files. Address each one, then answer every';
const HEADER_TWO =
  'comment with the answer_review_comment tool: its number, what you did, and fixed or not_fixed.';
const HEADER = HEADER_ONE + '\n' + HEADER_TWO;
const FOLDER = '/work/shop';

const CHECKOUT_1 = snapshotOf({
  number: 1,
  folder: FOLDER,
  path: 'src/cart/checkout.ts',
  side: 'new',
  startLine: 12,
  endLine: 12,
  quote: 'const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);',
  body: 'Вынеси подсчёт суммы в отдельную функцию.',
});

const DISCOUNT_2 = snapshotOf({
  number: 2,
  folder: FOLDER,
  path: 'src/cart/discount.ts',
  side: 'new',
  startLine: 3,
  endLine: 4,
  quote:
    'const row = await db.discounts.find(code);\nreturn row ? row.percent : 0;',
  body: 'Что будет, если скидка больше 100%? Ограничь значение.',
});

const DISCOUNT_4 = snapshotOf({
  number: 4,
  folder: FOLDER,
  path: 'src/cart/discount.ts',
  side: 'file',
  startLine: null,
  endLine: null,
  quote: '',
  body: 'Раздели файл на два.',
});

const SPEC_FILES = [
  'src/cart/checkout.ts',
  '  #1 · line 12 (new):',
  '      const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);',
  '    Вынеси подсчёт суммы в отдельную функцию.',
  'src/cart/discount.ts',
  '  #2 · lines 3–4 (new):',
  '      const row = await db.discounts.find(code);',
  '      return row ? row.percent : 0;',
  '    Что будет, если скидка больше 100%? Ограничь значение.',
  '  #4 · whole file:',
  '    Раздели файл на два.',
].join('\n');

describe('composeReviewText', () => {
  it('reproduces the spec example for its three comments, files in path order and comments by number', () => {
    const text = composeReviewText(
      null,
      [DISCOUNT_4, CHECKOUT_1, DISCOUNT_2],
      FOLDER,
    );

    expect(text).toBe(HEADER + '\n\n' + SPEC_FILES);
  });

  it('prints the note on its own line between two blank lines when one is given', () => {
    const text = composeReviewText(
      'Спасибо, вот правки.',
      [CHECKOUT_1, DISCOUNT_2, DISCOUNT_4],
      FOLDER,
    );

    expect(text).toBe(HEADER + '\n\nСпасибо, вот правки.\n\n' + SPEC_FILES);
  });

  it('uses the singular forms for one comment in one file', () => {
    const text = composeReviewText(null, [CHECKOUT_1], FOLDER);

    expect(text.split('\n')[0]).toBe(
      'Review of your changes — 1 comment in 1 file. Address each one, then answer every',
    );
  });

  it('prints a removed-line comment with (old), a single line or a range', () => {
    const single = snapshotOf({
      number: 5,
      folder: FOLDER,
      path: 'src/a.ts',
      side: 'old',
      startLine: 7,
      endLine: 7,
      quote: 'const gone = 1;',
      body: 'Why was this removed?',
    });
    const range = snapshotOf({
      number: 6,
      folder: FOLDER,
      path: 'src/a.ts',
      side: 'old',
      startLine: 7,
      endLine: 9,
      quote: 'a();\nb();\nc();',
      body: 'And these?',
    });

    const text = composeReviewText(null, [single, range], FOLDER);

    expect(text).toContain('  #5 · line 7 (old):');
    expect(text).toContain('  #6 · lines 7–9 (old):');
  });

  it('prints a quote as given, and snapshotOf cuts a quote over 20 lines with a line saying how many were left', () => {
    const lines = Array.from(
      { length: 25 },
      (_, i) => 'const v' + (i + 1) + ' = ' + (i + 1) + ';',
    );
    const long = snapshotOf({
      number: 7,
      folder: FOLDER,
      path: 'src/long.ts',
      side: 'new',
      startLine: 1,
      endLine: 25,
      quote: lines.join('\n'),
      body: 'Too long.',
    });

    expect(long.quote.split('\n')).toEqual([
      ...lines.slice(0, 20),
      '… 5 more lines',
    ]);

    const text = composeReviewText(null, [long], FOLDER);

    expect(text).toContain(
      [
        ...lines.slice(0, 20).map((line) => '      ' + line),
        '      … 5 more lines',
        '    Too long.',
      ].join('\n'),
    );
    expect(text).not.toContain('const v21 = 21;');
  });

  it('names a comment made in another folder, in a file header of its own before its path', () => {
    const elsewhere = snapshotOf({
      number: 2,
      folder: '/work/agent-wt',
      path: 'src/b.ts',
      side: 'file',
      startLine: null,
      endLine: null,
      quote: '',
      body: 'Check this worktree.',
    });

    const text = composeReviewText(null, [elsewhere, CHECKOUT_1], FOLDER);

    expect(text.split('\n').slice(3)).toEqual([
      'src/cart/checkout.ts',
      '  #1 · line 12 (new):',
      '      const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);',
      '    Вынеси подсчёт суммы в отдельную функцию.',
      '/work/agent-wt: src/b.ts',
      '  #2 · whole file:',
      '    Check this worktree.',
    ]);
  });

  it('lists the primary folder first, then the other folders alphabetically', () => {
    const inZeta = snapshotOf({
      number: 1,
      folder: '/work/zeta-wt',
      path: 'src/z.ts',
      side: 'file',
      startLine: null,
      endLine: null,
      quote: '',
      body: 'Zeta.',
    });
    const inAlpha = snapshotOf({
      number: 2,
      folder: '/work/alpha-wt',
      path: 'src/a.ts',
      side: 'file',
      startLine: null,
      endLine: null,
      quote: '',
      body: 'Alpha.',
    });
    const inPrimary = snapshotOf({
      number: 3,
      folder: FOLDER,
      path: 'src/p.ts',
      side: 'file',
      startLine: null,
      endLine: null,
      quote: '',
      body: 'Primary.',
    });

    const headers = composeReviewText(
      null,
      [inZeta, inAlpha, inPrimary],
      FOLDER,
    )
      .split('\n')
      .slice(3)
      .filter((line) => /^\S/.test(line));

    expect(headers).toEqual([
      'src/p.ts',
      '/work/alpha-wt: src/a.ts',
      '/work/zeta-wt: src/z.ts',
    ]);
  });

  it('keeps every body line indented four and every quote line six, and trims trailing whitespace', () => {
    const padded = snapshotOf({
      number: 1,
      folder: FOLDER,
      path: 'src/a.ts',
      side: 'new',
      startLine: 1,
      endLine: 1,
      quote: 'const a = 1;   ',
      body: 'First line.  \nSecond line.\t',
    });

    const text = composeReviewText('Note.   ', [padded], FOLDER);

    expect(text.split('\n').every((line) => line === line.trimEnd())).toBe(
      true,
    );
    expect(text).toContain('\n      const a = 1;\n');
    expect(text).toContain('\n    First line.\n    Second line.');
  });
});
