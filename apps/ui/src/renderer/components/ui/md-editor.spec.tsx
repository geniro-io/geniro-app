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
// spec is about, and jsdom cannot lay either out. The props are KEPT, so a spec
// can read what the editor was handed.
const editor = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));
vi.mock('@uiw/react-md-editor', () => ({
  default: (props: Record<string, unknown>) => {
    editor.props = props;
    return <div data-testid="mdeditor" />;
  },
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

  it('shows raw HTML in the preview as the characters that were typed', async () => {
    // `.claude/worktrees/<linear-id-slug>` opened an unknown element in the
    // vendor preview that swallowed every line after it. The preview's own
    // parser is not in this spec, so the plugin it is handed is run over the
    // tree remark would give it for that line.
    stubMatchMedia(false);
    setThemePreference('system');
    initTheme();
    await mount();

    const plugins =
      (
        editor.props?.previewOptions as
          { remarkPlugins?: unknown[] } | undefined
      )?.remarkPlugins ?? [];
    const placeholder = { type: 'html', value: '<linear-id-slug>' };
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'worktrees/' }, placeholder],
        },
      ],
    };
    for (const plugin of plugins) {
      (plugin as () => (node: unknown) => void)()(tree);
    }

    expect(placeholder).toEqual({ type: 'text', value: '<linear-id-slug>' });
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
