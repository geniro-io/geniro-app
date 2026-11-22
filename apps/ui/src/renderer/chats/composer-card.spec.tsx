// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ComposerCard } from './composer-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ComposerCard>
        <textarea aria-label="Message" />
        <button type="button">Refresh plan limits</button>
      </ComposerCard>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function card(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-slot="composer-card"]')!;
}

function highlightClasses(): string[] {
  return card()
    .className.split(/\s+/)
    .filter((name) => /(border-ring|ring-\[3px\]|ring-ring\/30)$/.test(name));
}

function highlightSelectors(): string[] {
  return [
    ...new Set(
      highlightClasses().map((name) => name.slice(0, name.lastIndexOf(':'))),
    ),
  ];
}

const VARIANT_SELECTOR: Record<string, string> = {
  'focus-within': ':focus-within',
  'has-[textarea:focus]': ':has(textarea:focus)',
};

function highlighted(): boolean {
  const [variant, ...others] = highlightSelectors();
  expect(others).toHaveLength(0);
  const selector = VARIANT_SELECTOR[variant ?? ''];
  expect(selector).toBeDefined();
  return card().matches(selector ?? '');
}

describe('ComposerCard', () => {
  it('rings while its text field has focus', () => {
    act(() => container.querySelector('textarea')!.focus());
    expect(highlighted()).toBe(true);
  });

  it('stays unringed while a control inside it, such as a readout panel button, has focus', () => {
    act(() => container.querySelector('button')!.focus());
    expect(document.activeElement?.tagName).toBe('BUTTON');
    expect(highlighted()).toBe(false);
  });
});
