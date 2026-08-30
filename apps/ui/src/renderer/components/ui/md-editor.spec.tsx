// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTheme, setThemePreference } from '../../theme/apply-theme';
import { MdEditor } from './md-editor';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The real editor pulls in CodeMirror and a stylesheet; neither is what this
// spec is about, and jsdom cannot lay either out.
vi.mock('@uiw/react-md-editor', () => ({
  default: () => <div data-testid="mdeditor" />,
}));
vi.mock('@uiw/react-md-editor/markdown-editor.css', () => ({}));

let container: HTMLDivElement;
let root: Root | null = null;

function stubMatchMedia(dark: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: dark,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  container.remove();
});

async function mount(): Promise<void> {
  const mounted = createRoot(container);
  root = mounted;
  await act(async () => {
    mounted.render(<MdEditor value="" />);
  });
}

describe('MdEditor', () => {
  it('tells the vendor which way round the theme is', async () => {
    // `data-color-mode` was pinned to "light", which under a dark theme left
    // every Primer variable the app's retint does NOT override painting for a
    // white page — inside a dark window.
    stubMatchMedia(true);
    setThemePreference('system');
    initTheme();

    await mount();

    expect(
      container
        .querySelector('.md-editor-surface')
        ?.getAttribute('data-color-mode'),
    ).toBe('dark');
  });

  it('says light under the light theme', async () => {
    stubMatchMedia(false);
    setThemePreference('system');
    initTheme();

    await mount();

    expect(
      container
        .querySelector('.md-editor-surface')
        ?.getAttribute('data-color-mode'),
    ).toBe('light');
  });

  it('follows a theme change while MOUNTED, without a remount', async () => {
    // The only path by which an already-open editor tracks a theme switch, and
    // the whole reason `useResolvedTheme` subscribes at all: with the store's
    // listener notification deleted, the tests above still pass (they set the
    // theme before mounting) and this one fails.
    stubMatchMedia(false);
    setThemePreference('system');
    initTheme();
    await mount();

    await act(async () => {
      setThemePreference('dark');
    });

    expect(
      container
        .querySelector('.md-editor-surface')
        ?.getAttribute('data-color-mode'),
    ).toBe('dark');
  });
});
