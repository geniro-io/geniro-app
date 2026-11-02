// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DiffView, editDiffOf, UnifiedDiff } from './diff-view';

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
  it('renders old lines as red "-" rows and new lines as green "+" rows', () => {
    act(() => root.render(<DiffView oldText={'a\nb'} newText={'a\nc\nd'} />));

    const minus = [...container.querySelectorAll('.text-destructive')];
    const plus = [...container.querySelectorAll('.text-success')];
    expect(minus).toHaveLength(2);
    expect(plus).toHaveLength(3);
    expect(minus[0]?.textContent).toContain('-');
    expect(minus[0]?.textContent).toContain('a');
    expect(plus[1]?.textContent).toContain('+');
    expect(plus[1]?.textContent).toContain('c');
  });

  it('a file creation (no oldText) renders only added lines', () => {
    act(() => root.render(<DiffView newText={'line 1\nline 2'} />));

    expect(container.querySelectorAll('.text-destructive')).toHaveLength(0);
    expect(container.querySelectorAll('.text-success')).toHaveLength(2);
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
