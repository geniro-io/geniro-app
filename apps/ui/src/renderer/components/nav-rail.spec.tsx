// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type Settings } from '../../shared/contracts';
import { type AppView, NavRail } from './nav-rail';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/**
 * The rail reads its remembered width from settings and writes it back, so the
 * IPC surface has to exist for it to mount at all. Stubbed per test with the
 * real default shape, and `updateSettings` is a spy because "was the choice
 * persisted" is exactly what one of these tests is about.
 */
const getSettings = vi.fn(async (): Promise<Settings> => DEFAULT_SETTINGS);
const updateSettings = vi.fn(async (patch: Partial<Settings>) => ({
  ...DEFAULT_SETTINGS,
  ...patch,
}));

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue(DEFAULT_SETTINGS);
  updateSettings.mockReset().mockResolvedValue(DEFAULT_SETTINGS);
  (globalThis as { window?: { geniro?: unknown } }).window!.geniro = {
    getSettings,
    updateSettings,
  } as unknown as Window['geniro'];
});

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

function rail(
  view: AppView,
  onNavigate: (next: AppView) => void = () => undefined,
  update?: { version: string | null; onInstall?: () => void },
): HTMLDivElement {
  return render(
    <NavRail
      view={view}
      onNavigate={onNavigate}
      connected
      updateVersion={update?.version ?? null}
      onInstallUpdate={update?.onInstall}
      daemonVersion="1.2.3"
      debugOpen={false}
      onToggleDebug={() => undefined}
    />,
  );
}

const buttonNamed = (el: HTMLElement, label: string): HTMLButtonElement =>
  [...el.querySelectorAll('button')].find(
    (node) => node.textContent === label,
  ) as HTMLButtonElement;

describe('NavRail', () => {
  it('offers every top-level destination', () => {
    const el = rail('chats');

    for (const label of ['Chats', 'Graphs', 'Stats', 'Settings']) {
      expect(buttonNamed(el, label)).toBeTruthy();
    }
  });

  it('navigates to Stats when its row is clicked', () => {
    const onNavigate = vi.fn();
    const el = rail('chats', onNavigate);

    act(() => {
      buttonNamed(el, 'Stats').click();
    });

    expect(onNavigate).toHaveBeenCalledWith('stats');
  });

  it('marks the current destination for assistive tech', () => {
    const el = rail('stats');

    expect(buttonNamed(el, 'Stats').getAttribute('aria-current')).toBe('page');
    expect(buttonNamed(el, 'Chats').getAttribute('aria-current')).toBeNull();
  });

  it('keeps Settings pinned below the primary destinations', () => {
    const el = rail('chats');
    const labels = [...el.querySelectorAll('button')]
      .map((node) => node.textContent)
      .filter((text): text is string =>
        ['Chats', 'Graphs', 'Stats', 'Settings'].includes(text ?? ''),
      );

    // Stats is a primary destination, so it belongs with Chats and Graphs
    // rather than in the utility group Settings sits in.
    expect(labels).toEqual(['Chats', 'Graphs', 'Stats', 'Settings']);
  });

  it('opens on the width it was left at, and writes every change back', async () => {
    getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      sidebarCollapsed: true,
    });
    const el = rail('chats');

    // Collapsed from the stored value: the labels are gone and the control
    // offers to EXPAND, which is only true of a rail that opened collapsed.
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.querySelector('[aria-label="Expand menu"]')).toBeTruthy();
    expect(buttonNamed(el, 'Chats')).toBeUndefined();

    await act(async () => {
      el.querySelector<HTMLButtonElement>(
        '[aria-label="Expand menu"]',
      )!.click();
    });

    expect(updateSettings).toHaveBeenCalledWith({ sidebarCollapsed: false });
  });

  it('drops the connection dot while collapsed, and keeps it while open', async () => {
    getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      sidebarCollapsed: true,
    });
    const el = rail('chats');
    await act(async () => {
      await Promise.resolve();
    });

    // The dot is the only `rounded-full` span in the rail — collapsed, the row
    // is the debug trigger alone.
    expect(el.querySelectorAll('span.rounded-full')).toHaveLength(0);

    await act(async () => {
      el.querySelector<HTMLButtonElement>(
        '[aria-label="Expand menu"]',
      )!.click();
    });

    expect(el.querySelectorAll('span.rounded-full')).toHaveLength(1);
  });

  it('offers the update where the running version is already shown', () => {
    // The ask: "updates should show here, and the Update button should be right
    // here" — pointing at the footer that states `connected · v1.46.0`.
    const installed: string[] = [];
    const el = rail('chats', () => undefined, {
      version: '1.47.0',
      onInstall: () => installed.push('pressed'),
    });
    const button = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Update',
    );
    expect(button).toBeTruthy();
    expect(button?.title).toContain('1.47.0');
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(installed).toEqual(['pressed']);
  });

  it('offers nothing when there is no update to install', () => {
    const el = rail('chats');
    const button = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Update',
    );
    expect(button).toBeUndefined();
  });

  it('shows no button for an update this install cannot apply', () => {
    // `canInstall: false` reaches here as a null version: a control that cannot
    // work is worse than none in a row this small, and Settings carries the
    // `brew` sentence for that case.
    const el = rail('chats', () => undefined, { version: null });
    expect(
      [...el.querySelectorAll('button')].some(
        (b) => b.textContent?.trim() === 'Update',
      ),
    ).toBe(false);
  });
});
