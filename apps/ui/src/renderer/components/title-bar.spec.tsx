// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import {
  TITLEBAR_CONTENT_INSET,
  TRAFFIC_LIGHT_INSET,
  TRAFFIC_LIGHT_WIDTH,
  UPDATE_COMMAND,
  type UpdateState,
} from '../../shared/contracts';
import { footerUpdate } from '../updates/update-status';
import { TitleBar } from './title-bar';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function bar(
  options: {
    title?: string;
    connected?: boolean;
    daemonVersion?: string | null;
    debugOpen?: boolean;
    onToggleDebug?: () => void;
    update?: {
      state: UpdateState | null;
      engaged?: boolean;
      onInstall?: () => void;
      onRelaunch?: () => void;
    };
  } = {},
): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <TitleBar
        title={options.title ?? 'New chat'}
        connected={options.connected ?? true}
        daemonVersion={options.daemonVersion ?? '1.2.3'}
        // Through the REAL projection, not a hand-made value: what the bar
        // shows for a given phase is the thing under test, so a fixture that
        // skipped `footerUpdate` would pin the markup against a shape nothing
        // produces.
        update={footerUpdate(
          options.update?.state ?? null,
          options.update?.engaged ?? false,
        )}
        onInstallUpdate={options.update?.onInstall}
        onRelaunchUpdate={options.update?.onRelaunch}
        debugOpen={options.debugOpen ?? false}
        onToggleDebug={options.onToggleDebug ?? (() => undefined)}
      />,
    );
  });
  return container;
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

const updateControl = (el: HTMLElement): HTMLButtonElement | null =>
  el.querySelector<HTMLButtonElement>('[data-slot="update-control"]');

describe('TitleBar', () => {
  it('is the window’s drag handle, and still lets its own controls be pressed', () => {
    // The OS strip is hidden, so this row IS the drag handle — a window with no
    // `app-region: drag` cannot be moved at all. The catch is the other half: a
    // control inside a drag region never receives the click, because the
    // compositor takes the press for the window.
    const pressed: string[] = [];
    const el = bar({ onToggleDebug: () => pressed.push('debug') });
    const titlebar = el.querySelector('[data-slot="titlebar"]');

    expect(titlebar?.classList.contains('app-drag')).toBe(true);
    const control = el.querySelector<HTMLButtonElement>(
      '[aria-label="Debug log"]',
    );
    expect(control?.classList.contains('app-no-drag')).toBe(true);
    act(() => {
      control?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(pressed).toEqual(['debug']);
  });

  it('clears the window buttons, by their measured footprint rather than a guess', () => {
    // REPORTED as "это криво". The reservation used to be a hand-written
    // `pl-[50px]` derived from a 52px button group — right for years of macOS,
    // wrong on 26, where the group measures 59.5px. Eight pixels short is the
    // green button drawn over what sits beside it. Asserted against the shared
    // constant so a re-measure moves the reservation with it, rather than
    // against a literal this test would simply restate.
    const titlebar = bar().querySelector<HTMLElement>('[data-slot="titlebar"]');

    expect(
      Number.parseFloat(titlebar!.style.paddingLeft),
    ).toBeGreaterThanOrEqual(TRAFFIC_LIGHT_INSET.x + TRAFFIC_LIGHT_WIDTH);
    expect(TITLEBAR_CONTENT_INSET).toBeGreaterThanOrEqual(
      TRAFFIC_LIGHT_INSET.x + TRAFFIC_LIGHT_WIDTH,
    );
  });

  it('names what the window is showing', () => {
    // The OS strip said "Geniro" and nothing else, directly above a row that
    // already named the open chat. This says the thing instead.
    const el = bar({ title: 'Refine the plan' });

    expect(el.querySelector('[data-slot="titlebar-title"]')?.textContent).toBe(
      'Refine the plan',
    );
  });

  it('centres the title on the WINDOW, and lets nothing displace it', () => {
    // REPORTED twice. It was centred over the CONTENT pane, measured from the
    // column widths — right until a column opens on the other side: with the
    // agents panel out, the midpoint of "everything right of the chat list"
    // sits well right of the transcript, and the title drifted with it
    // ("тайтл в хедере все еще как-то сдвинут, он не посередине", measured at
    // 1322px into a 2000px window).
    const el = bar();
    const title = el.querySelector('[data-slot="titlebar-title"]');
    const classes = (title?.getAttribute('class') ?? '').split(/\s+/);

    // Centred against the bar itself, which spans the window.
    expect(classes).toContain('absolute');
    expect(classes).toContain('left-1/2');
    expect(classes).toContain('-translate-x-1/2');
    expect(title?.parentElement?.dataset.slot).toBe('titlebar');

    // …and nothing between the bar's edges can shift that centre. A flex `gap`
    // displaces every child after it by its own width — measured 8px out when
    // the bar carried one. jsdom computes no layout, so the gap is the
    // observable: spacing belongs to the children.
    const bandClasses = (
      el.querySelector('[data-slot="titlebar"]')?.getAttribute('class') ?? ''
    ).split(/\s+/);
    expect(bandClasses.some((c) => /^gap(-x)?-/.test(c))).toBe(false);
  });

  it('offers the update, and reports which version it is offering', () => {
    const installed: string[] = [];
    const el = bar({
      update: {
        state: updateState({ phase: 'available', version: '1.47.0' }),
        onInstall: () => installed.push('pressed'),
      },
    });

    const button = updateControl(el);
    expect(button?.title).toContain('1.47.0');
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(installed).toEqual(['pressed']);
  });

  it('states the offer without a filled button', () => {
    // "not a button, something more compact" — a primary-filled pill is the
    // loudest thing in the shell for an offer with no deadline, so the control
    // must not carry the primary FILL. Asserted on the class the fill would
    // come from, because that is the observable the complaint was about.
    const el = bar({
      update: {
        state: updateState({ phase: 'available', version: '1.47.0' }),
        onInstall: () => undefined,
      },
    });

    const button = updateControl(el);
    expect(button?.className).not.toContain('bg-sidebar-primary');
    // …and it says the version rather than the word "Update".
    expect(button?.textContent?.trim()).toBe('1.47.0');
  });

  it('offers nothing when there is no update to install', () => {
    expect(updateControl(bar())).toBeNull();
  });

  it('offers a non-interactive readout, never a dead button, for an update this install cannot apply', () => {
    const el = bar({
      update: {
        state: updateState({
          phase: 'available',
          version: '1.47.0',
          canInstall: false,
          message: `Update with: ${UPDATE_COMMAND}`,
        }),
      },
    });
    // Not the pressable control — the shell's rule is "no dead affordance".
    expect(updateControl(el)).toBeNull();

    const readout = el.querySelector('[data-slot="update-readout"]');
    expect(readout?.tagName).not.toBe('BUTTON');
    expect(readout?.getAttribute('title')).toContain(UPDATE_COMMAND);
  });

  it('reports a download in flight, and refuses to be pressed', () => {
    const el = bar({
      update: {
        state: updateState({
          phase: 'downloading',
          version: '1.47.0',
          progress: 0.62,
        }),
      },
    });

    const button = updateControl(el);
    expect(button?.textContent?.trim()).toBe('62%');
    expect(button?.disabled).toBe(true);
  });

  it('offers a restart once the swap is done, and relaunches rather than reinstalling', () => {
    const pressed: string[] = [];
    const el = bar({
      update: {
        state: updateState({ phase: 'ready', version: '1.47.0' }),
        onInstall: () => pressed.push('install'),
        onRelaunch: () => pressed.push('relaunch'),
      },
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
    // GitHub — not a fault to put a warning glyph in the title bar for.
    expect(updateControl(bar({ update: { state: failed } }))).toBeNull();
    act(() => {
      root?.unmount();
    });
    container?.remove();

    const engaged = bar({
      update: { state: failed, engaged: true, onInstall: () => undefined },
    });
    // main's own words, carried through rather than re-worded here.
    expect(updateControl(engaged)?.title).toContain('checksum did not match');
  });

  it('carries the daemon status and version, which the rail no longer does', () => {
    // They sat in the rail's footer under a rule, and collapsing the rail left
    // a single green pip alone under a line — "вот эта точка выглядит
    // одна-одиноко". Here the version also sits beside the update offering a
    // newer one, which is the comparison a user actually makes.
    const status = bar({
      connected: true,
      daemonVersion: '1.48.1',
    }).querySelector('[data-slot="titlebar-status"]');

    expect(status?.textContent).toContain('1.48.1');
    expect(status?.querySelectorAll('span.rounded-full')).toHaveLength(1);
    act(() => {
      root?.unmount();
    });
    container?.remove();

    expect(
      bar({ connected: false }).querySelector('[data-slot="titlebar-status"]')
        ?.textContent,
    ).toContain('disconnected');
  });

  it('marks the debug trigger pressed while the drawer is open', () => {
    expect(
      bar({ debugOpen: true })
        .querySelector('[aria-label="Debug log"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
  });
});
