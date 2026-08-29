// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DiffView, editDiffOf } from './diff-view';

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
