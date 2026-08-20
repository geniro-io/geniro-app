// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type Settings } from '../../shared/contracts';
import { useSidebarCollapsed } from './use-sidebar-collapsed';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const getSettings = vi.fn(async (): Promise<Settings> => DEFAULT_SETTINGS);
const updateSettings = vi.fn(async (patch: Partial<Settings>) => ({
  ...DEFAULT_SETTINGS,
  ...patch,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue(DEFAULT_SETTINGS);
  updateSettings.mockReset().mockResolvedValue(DEFAULT_SETTINGS);
  (globalThis as { window?: { geniro?: unknown } }).window!.geniro = {
    getSettings,
    updateSettings,
  } as unknown as Window['geniro'];
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

/**
 * A probe that renders the hook's answer, so the test asserts on what a
 * consumer would actually see rather than on the hook's internals.
 */
function Probe(): React.JSX.Element {
  const { collapsed, hydrated, toggle } = useSidebarCollapsed();
  return (
    <button type="button" data-hydrated={String(hydrated)} onClick={toggle}>
      {collapsed ? 'collapsed' : 'open'}
    </button>
  );
}

async function mount(): Promise<HTMLButtonElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container.querySelector('button')!;
}

describe('useSidebarCollapsed', () => {
  it('opens on the width it was left at, and writes every change back', async () => {
    getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      sidebarCollapsed: true,
    });

    const button = await mount();
    expect(button.textContent).toBe('collapsed');

    await act(async () => {
      button.click();
    });

    expect(button.textContent).toBe('open');
    expect(updateSettings).toHaveBeenCalledWith({ sidebarCollapsed: false });
  });

  it('holds the animation until the stored choice has been applied', async () => {
    // The settings read resolves a frame or two after mount, so an animated
    // correction would show every launch sliding the rail shut — which looks
    // like the app forgetting and then remembering.
    getSettings.mockReturnValue(new Promise<Settings>(() => undefined));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });

    expect(container.querySelector('button')?.dataset.hydrated).toBe('false');
  });

  it('falls back to the default rather than a broken rail when settings cannot be read', async () => {
    getSettings.mockRejectedValue(new Error('settings.json is not JSON'));

    const button = await mount();

    // An unreadable settings file costs the remembered width and nothing else —
    // and `hydrated` still flips, or the rail would never animate again.
    expect(button.textContent).toBe('open');
    expect(button.dataset.hydrated).toBe('true');
  });
});
