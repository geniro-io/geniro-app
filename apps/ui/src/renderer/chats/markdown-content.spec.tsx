// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { alignClass, MarkdownContent } from './markdown-content';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

/** A real GFM table, parsed by the real remark-gfm the component uses. */
const ALIGNED_TABLE = [
  '| left | middle | right |',
  '| :--- | :----: | ----: |',
  '| a | b | c |',
].join('\n');

describe('MarkdownContent code', () => {
  it('routes a fenced block through the app CodeBlock, with its language', () => {
    const el = render(<MarkdownContent content={'```ts\nconst a = 1;\n```'} />);
    const block = el.querySelector('[data-slot="code-block"]');
    expect(block).not.toBeNull();
    expect(block?.getAttribute('data-language')).toBe('typescript');
    // Routing is the point: a fenced block must get the same surface a tool
    // payload gets, copy affordance included.
    expect(el.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
  });

  it('does not nest a <pre> inside a <pre>', () => {
    // CodeBlock renders its own <pre>; leaving the markdown `pre` renderer in
    // place would produce invalid HTML the browser silently reflows.
    const el = render(<MarkdownContent content={'```ts\nconst a = 1;\n```'} />);
    expect(el.querySelectorAll('pre pre')).toHaveLength(0);
  });

  it('leaves inline code inline — no block, no copy button', () => {
    const el = render(<MarkdownContent content={'use `npm ci` here'} />);
    expect(el.querySelector('[data-slot="code-block"]')).toBeNull();
    expect(el.querySelector('code')?.textContent).toBe('npm ci');
  });

  it('drops the fence-closing newline instead of rendering a blank last line', () => {
    const el = render(<MarkdownContent content={'```\nalpha\nbeta\n```'} />);
    expect(el.querySelector('[data-slot="code-block"] code')?.textContent).toBe(
      'alpha\nbeta',
    );
  });
});

describe('MarkdownContent tables', () => {
  it('lets a wide table scroll instead of hard-wrapping inside its wrapper', () => {
    const el = render(<MarkdownContent content={ALIGNED_TABLE} />);
    const wrapper = el.querySelector('table')?.parentElement;
    const table = el.querySelector('table');

    // The wrapper is the scroll container...
    expect(wrapper?.className).toContain('overflow-x-auto');
    // ...and the table must NOT be pinned to its width, or there is never any
    // overflow to scroll: content wraps to fit and long cells become unreadable
    // columns instead. This is the whole fix — if `w-full` comes back, the
    // table clips again.
    expect(table?.className).not.toContain('w-full');
  });

  it('carries GFM column alignment through to th and td', () => {
    const el = render(<MarkdownContent content={ALIGNED_TABLE} />);
    const headers = [...el.querySelectorAll('th')];
    const cells = [...el.querySelectorAll('tbody td')];

    expect(headers.map((h) => h.textContent)).toEqual([
      'left',
      'middle',
      'right',
    ]);
    // `:---:` is centred and `---:` is right-aligned — the alignment the author
    // wrote, not the default the old renderer hardcoded for every column.
    expect(headers[1]?.className).toContain('text-center');
    expect(headers[2]?.className).toContain('text-right');
    expect(cells[1]?.className).toContain('text-center');
    expect(cells[2]?.className).toContain('text-right');
  });

  it('leaves an unaligned column left-aligned, as before', () => {
    const el = render(
      <MarkdownContent
        content={['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')}
      />,
    );
    for (const cell of el.querySelectorAll('th, td')) {
      expect(cell.className).toContain('text-left');
      expect(cell.className).not.toContain('text-center');
      expect(cell.className).not.toContain('text-right');
    }
  });
});

describe('alignClass — the align-PROP fallback', () => {
  it('reads the style react-markdown actually produces today', () => {
    // Probe-verified: react-markdown translates the hast `align` property into
    // `style.textAlign` before the component sees it, so this is the live path
    // and both table tests above go through it.
    expect(alignClass({ textAlign: 'center' }, undefined)).toBe('text-center');
    expect(alignClass({ textAlign: 'right' }, undefined)).toBe('text-right');
    expect(alignClass(undefined, undefined)).toBe('text-left');
  });

  it('still reads a bare align PROP, for a version that stops translating', () => {
    // The branch exists for forward-compatibility, so nothing in the rendered
    // table can reach it — deleting the `?? align` fallback left all UI tests
    // green. A defensive branch worth keeping is worth a test that enters it
    // (.claude/rules/testing.md); this is that test.
    expect(alignClass(undefined, 'center')).toBe('text-center');
    expect(alignClass(undefined, 'right')).toBe('text-right');
    // Style wins when both are present — it is the current, translated form.
    expect(alignClass({ textAlign: 'right' }, 'center')).toBe('text-right');
  });
});
