// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GeniroApi,
  Settings as SettingsShape,
} from '../../shared/contracts';
import { Settings } from './Settings';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const settings: SettingsShape = {
  onboardingComplete: true,
  projectFolder: '/proj',
  recentFolders: [],
  lastChatTarget: null,
  cliPaths: {},
  checkForUpdates: false,
};

const geniro = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  detectClis: vi.fn(),
  hasSecret: vi.fn(),
  saveSecret: vi.fn(),
  deleteSecret: vi.fn(),
  pickAgentBinary: vi.fn(),
  checkForUpdates: vi.fn(),
};

let container: HTMLDivElement;
let root: Root | null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => {
    mountedRoot.render(<Settings />);
  });
}

beforeEach(() => {
  geniro.getSettings.mockReset().mockResolvedValue(settings);
  geniro.updateSettings.mockReset().mockResolvedValue(settings);
  geniro.detectClis.mockReset().mockResolvedValue([]);
  geniro.hasSecret.mockReset().mockResolvedValue(false);
  geniro.checkForUpdates.mockReset().mockResolvedValue({
    status: 'up-to-date',
    version: '0.1.0',
    message: null,
  });
  (window as unknown as { geniro: Partial<GeniroApi> }).geniro =
    geniro as unknown as Partial<GeniroApi>;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container.remove();
});

describe('Settings updates section', () => {
  it('seeds the update toggle from persisted settings', async () => {
    await mount();

    const toggle = container.querySelector('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
  });

  it('does not overwrite a user toggle when the initial settings read resolves late', async () => {
    let resolveSettings!: (value: SettingsShape) => void;
    geniro.getSettings.mockReturnValueOnce(
      new Promise<SettingsShape>((resolve) => {
        resolveSettings = resolve;
      }),
    );
    await mount();
    const toggle =
      container.querySelector<HTMLButtonElement>('[role="switch"]')!;

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      resolveSettings({ ...settings, checkForUpdates: true });
      await Promise.resolve();
    });

    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('auto-saves the update toggle on flip — no Save button', async () => {
    await mount();
    // The Save button is gone; flipping the switch must persist on its own.
    expect(
      [...container.querySelectorAll('button')].some((b) =>
        b.textContent?.includes('Save changes'),
      ),
    ).toBe(false);

    const toggle =
      container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(geniro.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ checkForUpdates: true }),
    );
    // The switch reflects the new state immediately.
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('ignores an older toggle write failure after the latest write succeeds', async () => {
    let rejectFirst!: (reason: unknown) => void;
    let resolveSecond!: (value: SettingsShape) => void;
    geniro.updateSettings
      .mockReturnValueOnce(
        new Promise<SettingsShape>((_resolve, reject) => {
          rejectFirst = reject;
        }),
      )
      .mockReturnValueOnce(
        new Promise<SettingsShape>((resolve) => {
          resolveSecond = resolve;
        }),
      );
    await mount();
    const toggle =
      container.querySelector<HTMLButtonElement>('[role="switch"]')!;

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      resolveSecond(settings);
      await Promise.resolve();
      rejectFirst(new Error('older write failed'));
      await Promise.resolve();
    });

    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).not.toContain('older write failed');
  });

  it('runs a manual update check and reports the outcome', async () => {
    await mount();
    const check = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Check now'),
    )!;

    await act(async () => {
      check.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(geniro.checkForUpdates).toHaveBeenCalled();
    expect(container.textContent).toContain('Up to date (v0.1.0)');
  });

  it('renders the available-update message (with the update command) and a failed check', async () => {
    geniro.checkForUpdates.mockResolvedValueOnce({
      status: 'available',
      version: '0.2.0',
      message: 'v0.2.0 is available — update with: brew upgrade --cask geniro',
    });
    await mount();
    const check = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Check now'),
    )!;

    await act(async () => {
      check.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Assert on text unique to the check RESULT, not the always-present static
    // hint (which also mentions brew) — else this passes with the result unshown.
    expect(container.textContent).toContain('v0.2.0 is available');

    geniro.checkForUpdates.mockRejectedValueOnce(new Error('ipc broke'));
    await act(async () => {
      check.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('ipc broke');
  });

  it('flushes a pending CLI path edit when Settings unmounts', async () => {
    await mount();
    const claudeToggle = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('claude'),
    )!;
    await act(async () => {
      claudeToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input =
      container.querySelector<HTMLInputElement>('#agent-path-claude')!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(input, '  /opt/new-claude  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(geniro.updateSettings).not.toHaveBeenCalled();
    await act(async () => root?.unmount());
    root = null;

    expect(geniro.updateSettings).toHaveBeenCalledWith({
      cliPaths: { claude: '/opt/new-claude' },
    });
  });
});
