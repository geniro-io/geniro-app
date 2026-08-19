// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SETTINGS,
  type Settings,
  type UpdateState,
} from '../../shared/contracts';
import { footerUpdate } from '../updates/update-status';
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
  update?: {
    state: UpdateState | null;
    engaged?: boolean;
    onInstall?: () => void;
    onRelaunch?: () => void;
  },
): HTMLDivElement {
  return render(
    <NavRail
      view={view}
      onNavigate={onNavigate}
      connected
      // Through the REAL projection, not a hand-made value: what this row shows
      // for a given phase is the thing under test, so a fixture that skipped
      // `footerUpdate` would pin the markup against a shape nothing produces.
      update={footerUpdate(update?.state ?? null, update?.engaged ?? false)}
      onInstallUpdate={update?.onInstall}
      onRelaunchUpdate={update?.onRelaunch}
      daemonVersion="1.2.3"
      debugOpen={false}
      onToggleDebug={() => undefined}
    />,
  );
}

/** An `UpdateState` with only the fields a case cares about spelled out. */
function updateState(patch: Partial<UpdateState>): UpdateState {
  return {
    phase: 'idle',
    version: null,
    progress: null,
    message: null,
    currentVersion: '1.2.3',
    canInstall: true,
    ...patch,
  };
}

/**
 * The rail's update control, whatever phase it is in.
 *
 * By `data-slot` rather than by its text: the label is what several of these
 * cases are asserting ON, so finding it by that text would make each test pass
 * by construction — and the phases genuinely differ, from a version to a
 * percentage to nothing at all when collapsed.
 */
const updateControl = (el: HTMLElement): HTMLButtonElement | null =>
  el.querySelector<HTMLButtonElement>('[data-slot="update-control"]');

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

  it('is the window’s title bar, and lets its one control still be pressed', () => {
    // The OS strip is hidden, so this row IS the drag handle — a window with no
    // `app-region: drag` cannot be moved at all. The catch is the other half: a
    // control inside a drag region never receives the click, so the toggle has
    // to opt out or the rail can no longer be collapsed.
    const el = rail('chats');
    const titlebar = el.querySelector('[data-slot="titlebar"]');

    expect(titlebar?.classList.contains('app-drag')).toBe(true);
    const toggle = titlebar?.querySelector('[aria-label="Collapse menu"]');
    expect(toggle).toBeTruthy();
    expect(toggle?.classList.contains('app-no-drag')).toBe(true);
  });

  it('gives the toggle a row of its own once the lights fill the title bar', async () => {
    // Collapsed the rail is 64px and the traffic lights are 62 of them, so the
    // toggle cannot share that row — it moves below rather than being drawn
    // under the system's own buttons.
    getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      sidebarCollapsed: true,
    });
    const el = rail('chats');
    await act(async () => {
      await Promise.resolve();
    });

    const titlebar = el.querySelector('[data-slot="titlebar"]');
    expect(titlebar).toBeTruthy();
    expect(titlebar?.querySelector('[aria-label="Expand menu"]')).toBeNull();
    expect(el.querySelector('[aria-label="Expand menu"]')).toBeTruthy();
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
    // The ask: "the update control should only be at the bottom left, where the
    // current version is" — pointing at the footer that states `· v1.46.0`.
    const installed: string[] = [];
    const el = rail('chats', () => undefined, {
      state: updateState({ phase: 'available', version: '1.47.0' }),
      onInstall: () => installed.push('pressed'),
    });

    const button = updateControl(el);
    expect(button).toBeTruthy();
    expect(button?.title).toContain('1.47.0');
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(installed).toEqual(['pressed']);
  });

  it('states the offer without a filled button', () => {
    // The other half of the same ask — "not a button, something more compact".
    // A primary-filled pill is the loudest thing in the shell for an offer with
    // no deadline, so the control must not carry the sidebar's primary FILL.
    // Asserted on the class the fill would come from, because that is the
    // observable the complaint was actually about.
    const el = rail('chats', () => undefined, {
      state: updateState({ phase: 'available', version: '1.47.0' }),
      onInstall: () => undefined,
    });

    const button = updateControl(el);
    expect(button?.className).not.toContain('bg-sidebar-primary');
    // …and it says the version rather than the word "Update", so the row reads
    // as `v1.2.3 … 1.47.0` — the comparison the user makes at a glance.
    expect(button?.textContent?.trim()).toBe('1.47.0');
  });

  it('offers nothing when there is no update to install', () => {
    expect(updateControl(rail('chats'))).toBeNull();
  });

  it('shows no control for an update this install cannot apply', () => {
    // A control that cannot work is worse than none in a row this small, and
    // Settings carries the `brew` sentence for that case.
    const el = rail('chats', () => undefined, {
      state: updateState({
        phase: 'available',
        version: '1.47.0',
        canInstall: false,
      }),
    });
    expect(updateControl(el)).toBeNull();
  });

  it('reports a download in flight, and refuses to be pressed', () => {
    // The strip that used to carry a progress bar is gone, so this row is the
    // only thing left that can say a download is happening at all.
    const el = rail('chats', () => undefined, {
      state: updateState({
        phase: 'downloading',
        version: '1.47.0',
        progress: 0.62,
      }),
    });

    const button = updateControl(el);
    expect(button?.textContent?.trim()).toBe('62%');
    expect(button?.disabled).toBe(true);
  });

  it('offers a restart once the swap is done, and relaunches rather than reinstalling', () => {
    const pressed: string[] = [];
    const el = rail('chats', () => undefined, {
      state: updateState({ phase: 'ready', version: '1.47.0' }),
      onInstall: () => pressed.push('install'),
      onRelaunch: () => pressed.push('relaunch'),
    });

    act(() => {
      updateControl(el)?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    // The distinction is the whole point of the phase: the bundle is already on
    // disk, so installing again would re-download it and never restart.
    expect(pressed).toEqual(['relaunch']);
  });

  it('reports a failed install the user started, and stays silent about one they did not', () => {
    const failed = updateState({
      phase: 'error',
      message: 'checksum did not match',
    });

    // Nothing was pressed, so this is a background check that could not reach
    // GitHub — not a fault to put a warning glyph in the status row for.
    expect(
      updateControl(rail('chats', () => undefined, { state: failed })),
    ).toBeNull();

    const engaged = rail('chats', () => undefined, {
      state: failed,
      engaged: true,
      onInstall: () => undefined,
    });
    // main's own words, carried through rather than re-worded here.
    expect(updateControl(engaged)?.title).toContain('checksum did not match');
  });
});
