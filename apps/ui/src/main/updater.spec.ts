import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false, getVersion: vi.fn(() => '1.0.0') },
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: false,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
  },
}));

vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdater }));

import { checkForUpdates, checkOnLaunch } from './updater';

beforeEach(() => {
  mocks.app.isPackaged = false;
  mocks.autoUpdater.checkForUpdates.mockReset();
});

describe('checkForUpdates', () => {
  it('short-circuits in dev without touching electron-updater', async () => {
    const result = await checkForUpdates();

    expect(result.status).toBe('dev');
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('reports up-to-date when the feed matches the running version', async () => {
    mocks.app.isPackaged = true;
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '1.0.0' },
    });

    const result = await checkForUpdates();

    expect(result).toEqual({
      status: 'up-to-date',
      version: '1.0.0',
      message: null,
    });
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(mocks.autoUpdater.allowDowngrade).toBe(true);
  });

  it('reports an available version (downloaded in the background)', async () => {
    mocks.app.isPackaged = true;
    const downloadPromise = Promise.resolve([]);
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.1.0' },
      downloadPromise,
    });

    const result = await checkForUpdates();

    expect(result.status).toBe('available');
    expect(result.version).toBe('1.1.0');
  });

  it('swallows a background download rejection (never an unhandled rejection)', async () => {
    mocks.app.isPackaged = true;
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.1.0' },
      downloadPromise: Promise.reject(new Error('mid-download drop')),
    });

    const result = await checkForUpdates();

    expect(result.status).toBe('available');
    // The catch attached to downloadPromise keeps the rejection from surfacing.
    await new Promise((r) => setTimeout(r, 0));
  });

  it('reports up-to-date when the updater declines the feed version (rollback feed)', async () => {
    mocks.app.isPackaged = true;
    // A rollback publishes an OLDER version to the feed. electron-updater
    // refuses downgrades by default (allowDowngrade=false): its result carries
    // isUpdateAvailable=false and it downloads nothing — so reporting
    // 'available' with a "downloading … installs on the next launch" message
    // would leave Settings promising an install that never happens.
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '0.9.0' },
    });

    const result = await checkForUpdates();

    expect(result.status).toBe('up-to-date');
  });

  it('maps a feed failure to a structured error, never a throw', async () => {
    mocks.app.isPackaged = true;
    mocks.autoUpdater.checkForUpdates.mockRejectedValue(
      new Error('feed unreachable'),
    );

    const result = await checkForUpdates();

    expect(result.status).toBe('error');
    expect(result.message).toContain('feed unreachable');
  });
});

describe('checkOnLaunch', () => {
  it('does nothing when the settings toggle is off', () => {
    mocks.app.isPackaged = true;

    checkOnLaunch(false);

    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('fires the check when enabled on a packaged app', async () => {
    mocks.app.isPackaged = true;
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '1.0.0' },
    });

    checkOnLaunch(true);
    await vi.waitFor(() =>
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalled(),
    );
  });
});
