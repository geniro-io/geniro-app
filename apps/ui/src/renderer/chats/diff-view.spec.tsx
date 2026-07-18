// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DiffView } from './diff-view';

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
