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
  defaultModel: 'claude-sonnet-5',
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
let root: Root;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Settings />);
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
  await act(async () => root.unmount());
  container.remove();
});

describe('Settings defaults section', () => {
  it('seeds the default model and update-check from persisted settings', async () => {
    await mount();

    const model = container.querySelector<HTMLInputElement>('#default-model');
    const updates =
      container.querySelector<HTMLInputElement>('#check-for-updates');
    expect(model?.value).toBe('claude-sonnet-5');
    expect(updates?.checked).toBe(false);
  });

  it('saves the trimmed model (null when cleared) and the update toggle', async () => {
    await mount();
    const model = container.querySelector<HTMLInputElement>('#default-model')!;
    const updates =
      container.querySelector<HTMLInputElement>('#check-for-updates')!;

    // Clear the model and flip the toggle via native setters + change events.
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      setValue.call(model, '   ');
      model.dispatchEvent(new Event('input', { bubbles: true }));
      updates.click();
    });

    const save = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Save changes'),
    )!;
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(geniro.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: null, checkForUpdates: true }),
    );
  });

  it('saves a padded model trimmed', async () => {
    await mount();
    const model = container.querySelector<HTMLInputElement>('#default-model')!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      setValue.call(model, '  claude-x  ');
      model.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const save = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Save changes'),
    )!;
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(geniro.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: 'claude-x' }),
    );
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

  it('renders the available-update message and a failed check', async () => {
    geniro.checkForUpdates.mockResolvedValueOnce({
      status: 'available',
      version: '0.2.0',
      message: 'downloading v0.2.0 — it installs on the next launch',
    });
    await mount();
    const check = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Check now'),
    )!;

    await act(async () => {
      check.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Update available: v0.2.0');

    geniro.checkForUpdates.mockRejectedValueOnce(new Error('ipc broke'));
    await act(async () => {
      check.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('ipc broke');
  });
});
