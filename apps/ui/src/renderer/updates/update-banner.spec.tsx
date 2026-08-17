// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UpdateState } from '../../shared/contracts';
import { UpdateBanner, updateBannerVisible } from './update-banner';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function state(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    phase: 'available',
    version: '1.4.0',
    progress: null,
    message: null,
    currentVersion: '1.0.0',
    canInstall: true,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

async function render(node: React.JSX.Element): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const mounted = createRoot(container);
  root = mounted;
  await act(async () => mounted.render(node));
}

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  container?.remove();
});

describe('updateBannerVisible', () => {
  it('shows an offer, and stops showing THAT version once dismissed', () => {
    expect(updateBannerVisible(state(), null, false)).toBe(true);
    expect(updateBannerVisible(state(), '1.4.0', false)).toBe(false);
  });

  it('offers a NEWER release even after the previous one was dismissed', () => {
    // Dismissing v1.4.0 must not silence v1.5.0 — otherwise one wave of the
    // hand opts the user out of every future update this launch.
    expect(
      updateBannerVisible(state({ version: '1.5.0' }), '1.4.0', false),
    ).toBe(true);
  });

  it('cannot be dismissed once an install is under way', () => {
    for (const phase of ['downloading', 'installing', 'ready'] as const) {
      expect(updateBannerVisible(state({ phase }), '1.4.0', false)).toBe(true);
    }
  });

  it('shows a failed INSTALL but not a failed background check', () => {
    // The user pressed a button and is owed the outcome; nobody asked about
    // GitHub being unreachable, and that belongs in Settings.
    expect(updateBannerVisible(state({ phase: 'error' }), null, true)).toBe(
      true,
    );
    expect(updateBannerVisible(state({ phase: 'error' }), null, false)).toBe(
      false,
    );
  });

  it('shows nothing before main has answered, or when there is nothing to say', () => {
    expect(updateBannerVisible(null, null, false)).toBe(false);
    expect(
      updateBannerVisible(state({ phase: 'up-to-date' }), null, false),
    ).toBe(false);
    expect(updateBannerVisible(state({ phase: 'idle' }), null, false)).toBe(
      false,
    );
  });
});

describe('UpdateBanner', () => {
  it('names the version and installs on press', async () => {
    const onInstall = vi.fn();
    await render(
      <UpdateBanner
        state={state()}
        onInstall={onInstall}
        onDismiss={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('Geniro 1.4.0 is available');
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Update now'),
    )!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onInstall).toHaveBeenCalledOnce();
  });

  it('offers no Update button for a copy that cannot replace itself', async () => {
    await render(
      <UpdateBanner
        state={state({
          canInstall: false,
          message: 'Update with: brew upgrade --cask geniro',
        })}
        onInstall={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      [...container.querySelectorAll('button')].some((b) =>
        b.textContent?.includes('Update now'),
      ),
    ).toBe(false);
    expect(container.textContent).toContain('brew upgrade --cask geniro');
  });

  it('shows a determinate bar while downloading and hides the dismiss control', async () => {
    await render(
      <UpdateBanner
        state={state({ phase: 'downloading', progress: 0.42 })}
        onInstall={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    // Dismissing would hide a download still using the network and a swap
    // about to restart the app.
    expect(container.querySelector('[aria-label="Dismiss"]')).toBeNull();
  });

  it('drops to an indeterminate bar while unpacking, which reports no progress', async () => {
    await render(
      <UpdateBanner
        state={state({ phase: 'installing', progress: 1 })}
        onInstall={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const bar = container.querySelector('[role="progressbar"]')!;
    // A bar frozen at 100% for the half-minute a copy takes reads as hung.
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
  });
});
