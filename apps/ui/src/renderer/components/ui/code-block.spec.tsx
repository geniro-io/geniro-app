// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CodeBlock } from './code-block';
import { languageForPath } from './code-language';

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

function render(node: React.ReactNode): void {
  act(() => root.render(node));
}

describe('CodeBlock', () => {
  it('emits token spans a stylesheet can colour', () => {
    render(<CodeBlock code="const a = 1;" language="typescript" />);

    const tokens = container.querySelectorAll('.token');
    expect(tokens.length).toBeGreaterThan(0);
    // The keyword must be a token of its own — that is what the --code-keyword
    // rule hooks onto.
    expect(
      [...tokens].some(
        (el) => el.classList.contains('keyword') && el.textContent === 'const',
      ),
    ).toBe(true);
    expect(container.textContent).toContain('const a = 1;');
  });

  it('renders plain text for a language nothing can highlight', () => {
    render(<CodeBlock code="some output" language="not-a-language" />);

    expect(container.querySelectorAll('.token')).toHaveLength(0);
    expect(container.textContent).toContain('some output');
    expect(
      container
        .querySelector('[data-slot="code-block"]')
        ?.getAttribute('data-language'),
    ).toBe('text');
  });

  it('renders plain text when no language is given at all', () => {
    render(<CodeBlock code="a.ts\nb.ts" />);
    expect(container.querySelectorAll('.token')).toHaveLength(0);
    expect(container.textContent).toContain('a.ts');
  });

  it('shows the caption above the code', () => {
    render(<CodeBlock code="x" language={null} caption="/proj/a.ts" />);
    expect(container.textContent).toContain('/proj/a.ts');
  });

  it('WRAPS plain text, and leaves real code to scroll', () => {
    // A `<pre>` is `white-space: pre`, so a long line runs past the right edge
    // — and on macOS, where scrollbars stay hidden until you scroll, that reads
    // as a message cut in half. REPORTED as "а еще вижу там оборванное
    // сообщение" over an async-agent launch receipt: six lines of ordinary
    // English prose, every one clipped mid-sentence at the same x, because a
    // tool RESULT comes through this component whatever it holds.
    //
    // Code keeps `pre` — its columns carry meaning and a wrapped diff or
    // stack trace is worse than a scrolled one. `grammar === null` is the
    // discriminator, and these two cases are the two sides of it.
    //
    // The CLASS is the assertion because it IS the mechanism: jsdom computes no
    // layout, so the wrap itself is unobservable, and nothing else survives a
    // revert.
    render(<CodeBlock code={'a '.repeat(400)} />);
    const plain = container.querySelector('[data-slot="code-block"]');
    expect(plain?.className).toContain('whitespace-pre-wrap');
    expect(plain?.className).toContain('break-words');

    render(<CodeBlock code="const a = 1;" language="typescript" />);
    const code = container.querySelector('[data-slot="code-block"]');
    expect(code?.className).not.toContain('whitespace-pre-wrap');
  });
});

describe('languageForPath', () => {
  it('highlights .tsx — refractor does NOT register that grammar by default', () => {
    // The dominant file type in this repo; without an explicit register() it
    // would silently fall back to plain text.
    expect(languageForPath('/proj/App.tsx')).toBe('tsx');
    expect(languageForPath('/proj/a.jsx')).toBe('jsx');
  });

  it('maps the common extensions to grammars refractor really has', () => {
    expect(languageForPath('/a/b.ts')).toBe('typescript');
    expect(languageForPath('script.sh')).toBe('bash');
    expect(languageForPath('/etc/conf.yaml')).toBe('yaml');
    expect(languageForPath('/proj/q.py')).toBe('python');
  });

  it('answers null for a grammar the bundle does NOT ship, rather than throwing', () => {
    // The table names more languages than refractor's 62 registered grammars
    // cover (docker, graphql); every answer is gated through registered(), so
    // those degrade to plain text inside a render instead of crashing it.
    expect(languageForPath('Dockerfile')).toBeNull();
    expect(languageForPath('/proj/schema.graphql')).toBeNull();
  });

  it('answers null rather than guessing', () => {
    expect(languageForPath(null)).toBeNull();
    expect(languageForPath('/proj/LICENSE')).toBeNull();
    expect(languageForPath('/proj/a.unknownext')).toBeNull();
  });
});
