// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DIFF_ROW_LIMIT,
  diffRows,
  DiffView,
  editDiffOf,
  UnifiedDiff,
} from './diff-view';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DiffView', () => {
  it('renders removed lines as red "-" rows, added lines as green "+" rows and unchanged lines as context', () => {
    act(() => root.render(<DiffView oldText={'a\nb'} newText={'a\nc\nd'} />));

    const rows = [...container.querySelectorAll('[data-slot="diff"] > div')];
    expect(rows.map((row) => row.textContent)).toEqual([
      ' a',
      '-b',
      '+c',
      '+d',
    ]);
    expect(rows[0]?.className).not.toMatch(/text-(destructive|success)/);
    expect(rows[1]?.className).toContain('text-destructive');
    expect(rows[2]?.className).toContain('text-success');
  });

  it('folds each unchanged stretch longer than the context into one gap row naming its length', () => {
    const before = Array.from({ length: 100 }, (_, index) => `line ${index}`);
    const after = before.map((line, index) =>
      index === 20 || index === 80 ? `${line} changed` : line,
    );

    act(() =>
      root.render(
        <DiffView oldText={before.join('\n')} newText={after.join('\n')} />,
      ),
    );

    expect(
      [...container.querySelectorAll('[data-slot="diff-gap"]')].map(
        (gap) => gap.textContent,
      ),
    ).toEqual([
      '⋯ 17 unchanged lines',
      '⋯ 53 unchanged lines',
      '⋯ 16 unchanged lines',
    ]);
  });

  it('draws at most the row limit until Show all draws the rest', () => {
    const created = Array.from(
      { length: DIFF_ROW_LIMIT + 100 },
      (_, index) => `line ${index}`,
    ).join('\n');

    act(() => root.render(<DiffView newText={created} />));

    expect(container.querySelectorAll('.text-success')).toHaveLength(
      DIFF_ROW_LIMIT,
    );
    const showAll = [...container.querySelectorAll('button')].find(
      (button) =>
        button.textContent ===
        `Show all ${(DIFF_ROW_LIMIT + 100).toLocaleString('en-US')} rows`,
    );
    expect(showAll).toBeDefined();

    act(() => showAll?.click());

    expect(container.querySelectorAll('.text-success')).toHaveLength(
      DIFF_ROW_LIMIT + 100,
    );
    expect(container.querySelector('button')).toBeNull();
  });

  it('starts capped again when the texts change after Show all', () => {
    const created = (length: number): string =>
      Array.from({ length }, (_, index) => `line ${index}`).join('\n');

    act(() =>
      root.render(<DiffView newText={created(DIFF_ROW_LIMIT + 100)} />),
    );
    act(() => container.querySelector('button')?.click());
    act(() => root.render(<DiffView newText={created(DIFF_ROW_LIMIT + 50)} />));

    expect(container.querySelectorAll('.text-success')).toHaveLength(
      DIFF_ROW_LIMIT,
    );
  });

  it('keeps an unchanged last line as context when a line is appended after it', () => {
    act(() => root.render(<DiffView oldText={'a\nb'} newText={'a\nb\nc'} />));

    expect(
      [...container.querySelectorAll('[data-slot="diff"] > div')].map(
        (row) => row.textContent,
      ),
    ).toEqual([' a', ' b', '+c']);
  });

  it('names a one-line gap in the singular', () => {
    act(() =>
      root.render(
        <DiffView
          oldText={'l0\nl1\nl2\nl3\nl4'}
          newText={'l0\nl1\nl2\nl3\nL4'}
        />,
      ),
    );

    expect(container.querySelector('[data-slot="diff-gap"]')?.textContent).toBe(
      '⋯ 1 unchanged line',
    );
  });

  it('a one-line change inside whole-file texts draws only the changed lines and their context', () => {
    const before = Array.from({ length: 9000 }, (_, index) => `line ${index}`);
    const after = before.map((line, index) =>
      index === 4500 ? 'line 4500 changed' : line,
    );

    act(() =>
      root.render(
        <DiffView oldText={before.join('\n')} newText={after.join('\n')} />,
      ),
    );

    expect(
      [...container.querySelectorAll('[data-slot="diff"] > div')].map(
        (row) => row.textContent,
      ),
    ).toEqual([
      '⋯ 4,497 unchanged lines',
      ' line 4497',
      ' line 4498',
      ' line 4499',
      '-line 4500',
      '+line 4500 changed',
      ' line 4501',
      ' line 4502',
      ' line 4503',
      '⋯ 4,496 unchanged lines',
    ]);
  });

  it('a file creation (no oldText) renders only added lines', () => {
    act(() => root.render(<DiffView newText={'line 1\nline 2'} />));

    expect(container.querySelectorAll('.text-destructive')).toHaveLength(0);
    expect(container.querySelectorAll('.text-success')).toHaveLength(2);
  });
});

describe('diffRows', () => {
  it('when the line search gives up, keeps only what lies between the shared ends', () => {
    const shared = (prefix: string): string[] =>
      Array.from({ length: 50 }, (_, index) => `${prefix} ${index}`);
    const middle = (prefix: string): string[] =>
      Array.from({ length: 1500 }, (_, index) =>
        index % 100 === 50 ? 'common' : `${prefix} ${index}`,
      );
    const oldLines = [...shared('head'), ...middle('old'), ...shared('tail')];
    const newLines = [...shared('head'), ...middle('new'), ...shared('tail')];

    const rows = diffRows(oldLines.join('\n'), newLines.join('\n'));

    expect(rows.slice(0, 4)).toEqual([
      { kind: 'gap', skipped: 47 },
      { kind: 'context', text: 'head 47' },
      { kind: 'context', text: 'head 48' },
      { kind: 'context', text: 'head 49' },
    ]);
    expect(rows.filter((row) => row.kind === 'removed')).toHaveLength(1500);
    expect(rows.filter((row) => row.kind === 'added')).toHaveLength(1500);
    const firstRemoved = rows.findIndex((row) => row.kind === 'removed');
    const lastAdded = rows.findLastIndex((row) => row.kind === 'added');
    expect(
      rows
        .slice(firstRemoved, lastAdded + 1)
        .filter((row) => row.kind === 'context'),
    ).toEqual([]);
    expect(rows.slice(-4)).toEqual([
      { kind: 'context', text: 'tail 0' },
      { kind: 'context', text: 'tail 1' },
      { kind: 'context', text: 'tail 2' },
      { kind: 'gap', skipped: 47 },
    ]);
  });
});

describe('UnifiedDiff', () => {
  const classOf = (text: string): string | undefined =>
    [...container.querySelectorAll('[data-slot="unified-diff"] > div')]
      .find((line) => line.textContent === text)
      ?.getAttribute('class') ?? undefined;

  it('reads a changed line that begins with -- or ++ as a change, and git’s file headers as headers', () => {
    act(() =>
      root.render(
        <UnifiedDiff
          diff={[
            '--- a/rules.md',
            '+++ b/rules.md',
            '@@ -1,3 +1,3 @@',
            ' Rules',
            '----',
            '+++ always ask first',
            ' Use pnpm',
          ].join('\n')}
        />,
      ),
    );

    expect(classOf('--- a/rules.md')).toContain('text-muted-foreground');
    expect(classOf('+++ b/rules.md')).toContain('text-muted-foreground');
    expect(classOf('----')).toContain('text-destructive');
    expect(classOf('+++ always ask first')).toContain('text-success');
    expect(classOf(' Use pnpm')).toContain('text-foreground');
  });
});

describe('UnifiedDiff — changed words', () => {
  it('marks the words that changed inside a long line, and nothing when asked not to', () => {
    const long =
      'push to main on Fridays only after the suite passes and a reviewer approved';
    const diff = [
      '@@ -1,1 +1,1 @@',
      `-Never ${long}.`,
      `+Always ${long}.`,
    ].join('\n');

    act(() => root.render(<UnifiedDiff diff={diff} wordLevel />));
    expect(
      [...container.querySelectorAll('[data-changed]')].map(
        (span) => span.textContent,
      ),
    ).toEqual(['Never', 'Always']);

    act(() => root.render(<UnifiedDiff diff={diff} />));
    expect(container.querySelectorAll('[data-changed]')).toHaveLength(0);
  });
});

describe('editDiffOf', () => {
  it('reads an Edit, which is the shape the whole helper is built around', () => {
    expect(
      editDiffOf('Edit', { old_string: 'before', new_string: 'after' }),
    ).toEqual({ oldText: 'before', newText: 'after' });
  });

  it('reads a Write as additions only', () => {
    expect(editDiffOf('Write', { content: 'brand new' })).toEqual({
      oldText: null,
      newText: 'brand new',
    });
  });

  it('reads geniro’s propose_patch over the SAME field names', () => {
    // Why the tool advertises Edit's names: a proposal and an edit are the same
    // diff, differing only in who writes the file and when — so the card gets
    // its diff without a second diff renderer.
    expect(
      editDiffOf('propose_patch', {
        file_path: 'src/a.ts',
        old_string: 'const timeout = 30;',
        new_string: 'const timeout = 60;',
      }),
    ).toEqual({
      oldText: 'const timeout = 30;',
      newText: 'const timeout = 60;',
    });
  });

  it('reads a propose_patch with NO old_string as a whole-file write', () => {
    expect(
      editDiffOf('propose_patch', {
        file_path: 'src/new.ts',
        new_string: 'export const x = 1;\n',
      }),
    ).toEqual({ oldText: null, newText: 'export const x = 1;\n' });
  });

  it('reads a project-instructions card, and one for a project with none yet as additions', () => {
    expect(
      editDiffOf('save_project_instructions', {
        old_string: 'Use pnpm.',
        new_string: 'Use pnpm. Run pnpm test:unit.',
      }),
    ).toEqual({
      oldText: 'Use pnpm.',
      newText: 'Use pnpm. Run pnpm test:unit.',
    });
    expect(
      editDiffOf('save_project_instructions', { new_string: 'Use pnpm.' }),
    ).toEqual({ oldText: null, newText: 'Use pnpm.' });
  });

  it('KEEPS refusing an Edit with no old_string — that is a malformed call', () => {
    // The optional-old_string arm belongs to the proposal alone. Letting Edit
    // through it would draw a malformed edit as a confident file creation.
    expect(editDiffOf('Edit', { new_string: 'after' })).toBeNull();
  });

  it('answers null for a tool that is not a file edit at all', () => {
    expect(editDiffOf('Bash', { command: 'ls' })).toBeNull();
    expect(editDiffOf('propose_patch', { file_path: 'a.ts' })).toBeNull();
    expect(editDiffOf('Edit', null)).toBeNull();
  });
});
