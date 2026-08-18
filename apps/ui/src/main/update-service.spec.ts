import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UPDATE_COMMAND, type UpdateState } from '../shared/contracts';
import type { InstallInput } from './update-installer';
import { UpdateService, type UpdateServiceDeps } from './update-service';
import type { LatestRelease, ReleaseLookup } from './updater';

// `createUpdateService` (and only it) touches electron; the class under test
// takes every dependency as an argument.
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', isPackaged: true, getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
}));

const RELEASE: LatestRelease = {
  version: '1.4.0',
  zip: { name: 'Geniro-1.4.0-arm64-mac.zip', url: 'https://example.test/zip' },
  checksums: { name: 'SHA256SUMS.txt', url: 'https://example.test/sums' },
};

let broadcasts: UpdateState[];
let installed: InstallInput[];
let relaunched: number;

function build(overrides: Partial<UpdateServiceDeps> = {}): UpdateService {
  broadcasts = [];
  installed = [];
  relaunched = 0;
  return new UpdateService({
    currentVersion: () => '1.0.0',
    isPackaged: () => true,
    bundlePath: () => '/Applications/Geniro.app',
    workDir: () => '/tmp/updates',
    fetchLatest: (): Promise<ReleaseLookup> =>
      Promise.resolve({ ok: true, release: RELEASE }),
    install: async (input) => {
      installed.push(input);
    },
    canWrite: () => Promise.resolve(true),
    relaunch: () => {
      relaunched += 1;
    },
    broadcast: (state) => broadcasts.push(state),
    ...overrides,
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('UpdateService.check', () => {
  it('offers a newer release, and says which version', async () => {
    const service = build();

    const state = await service.check();

    expect(state).toMatchObject({
      phase: 'available',
      version: '1.4.0',
      canInstall: true,
      message: null,
    });
    // The renderer is told it is working before the network call, not only
    // after it — otherwise a slow feed is a button that does nothing.
    expect(broadcasts[0]?.phase).toBe('checking');
  });

  it('reports up-to-date when the feed is not ahead of this build', async () => {
    const service = build({ currentVersion: () => '1.4.0' });

    expect(await service.check()).toMatchObject({
      phase: 'up-to-date',
      version: '1.4.0',
    });
  });

  it('carries the lookup failure through verbatim', async () => {
    const service = build({
      fetchLatest: () => Promise.resolve({ ok: false, error: 'HTTP 503' }),
    });

    expect(await service.check()).toMatchObject({
      phase: 'error',
      message: 'HTTP 503',
    });
  });

  it('does not check at all in an unpackaged build', async () => {
    const fetchLatest = vi.fn();
    const service = build({ isPackaged: () => false, fetchLatest });

    const state = await service.check();

    expect(fetchLatest).not.toHaveBeenCalled();
    expect(state.phase).toBe('idle');
  });

  it('names the update command when this copy cannot replace itself', async () => {
    const service = build({ canWrite: () => Promise.resolve(false) });

    const state = await service.check();

    // An app installed by another user, or on a read-only volume: still worth
    // announcing the release, but with the one command that can apply it.
    expect(state).toMatchObject({ phase: 'available', canInstall: false });
    expect(state.message).toContain(UPDATE_COMMAND);
  });
});

describe('UpdateService.install', () => {
  it('installs the release the user was offered, and WAITS to be told to restart', async () => {
    const service = build();
    await service.check();

    const state = await service.install();

    expect(installed).toHaveLength(1);
    expect(installed[0]?.release).toBe(RELEASE);
    expect(installed[0]?.bundlePath).toBe('/Applications/Geniro.app');
    expect(state.phase).toBe('ready');
    // The version the app now reports is the one on disk, not the one it
    // launched as.
    expect(state.currentVersion).toBe('1.4.0');
    // The reported ask. Restarting quits the app and takes the daemon and every
    // running turn with it, so the moment belongs to the user.
    expect(relaunched).toBe(0);

    service.relaunch();
    expect(relaunched).toBe(1);
  });

  it('will not restart when there is nothing installed to restart into', async () => {
    // A press outside `ready` would quit the app and come back on the same
    // build — indistinguishable from a crash.
    const service = build();
    await service.check();

    service.relaunch();

    expect(relaunched).toBe(0);
  });

  it('refuses when nothing has been offered, rather than installing "whatever is latest"', async () => {
    const service = build();

    const state = await service.install();

    expect(state.phase).toBe('error');
    expect(installed).toHaveLength(0);
    expect(relaunched).toBe(0);
  });

  it('leaves a running download alone when install is pressed again', async () => {
    let calls = 0;
    let started!: () => void;
    let finish!: () => void;
    const downloading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = build({
      install: () => {
        calls += 1;
        started();
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    await service.check();

    const first = service.install();
    await downloading;

    // Neither a second download nor "there is no update ready to install" over
    // a running one — by then the phase IS `downloading`, so a readiness guard
    // consulted ahead of the busy latch would fail on the app's own state.
    expect((await service.install()).phase).toBe('downloading');
    expect(calls).toBe(1);

    finish();
    await first;
  });

  it('publishes download progress as it arrives', async () => {
    const service = build({
      install: async ({ onProgress, onStage }) => {
        onProgress?.({ fraction: 0.5, receivedBytes: 50, totalBytes: 100 });
        onProgress?.({ fraction: 1, receivedBytes: 100, totalBytes: 100 });
        onStage?.('installing');
      },
    });
    await service.check();

    await service.install();

    const progresses = broadcasts
      .filter((s) => s.phase === 'downloading')
      .map((s) => s.progress);
    expect(progresses).toContain(0.5);
    expect(progresses).toContain(1);
    expect(broadcasts.some((s) => s.phase === 'installing')).toBe(true);
  });

  it('does not relaunch into a failed install, and keeps the fallback command', async () => {
    const service = build({
      install: () => Promise.reject(new Error('checksum mismatch')),
    });
    await service.check();

    const state = await service.install();

    expect(state.phase).toBe('error');
    expect(state.message).toContain('checksum mismatch');
    expect(state.message).toContain(UPDATE_COMMAND);
    // Relaunching would restart the app onto the bundle it already had, which
    // reads as an update that silently did nothing.
    expect(relaunched).toBe(0);
  });

  it('recovers after a failed install — the next check can offer again', async () => {
    const service = build({
      install: () => Promise.reject(new Error('network down')),
    });
    await service.check();
    await service.install();

    // The `busy` latch must be released on the failure path, or the app is
    // stuck refusing every further check for the rest of the launch.
    expect((await service.check()).phase).toBe('available');
  });
});

describe('UpdateService scheduling', () => {
  it('checks on launch and on the interval, and stops when switched off', async () => {
    vi.useFakeTimers();
    const fetchLatest = vi.fn((): Promise<ReleaseLookup> =>
      Promise.resolve({ ok: true, release: RELEASE }),
    );
    const service = build({
      fetchLatest,
      intervalMs: 1000,
      launchDelayMs: 100,
    });

    service.start(true);
    expect(fetchLatest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchLatest).toHaveBeenCalledTimes(2);

    service.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it('schedules nothing when the user has switched automatic checks off', async () => {
    vi.useFakeTimers();
    const fetchLatest = vi.fn((): Promise<ReleaseLookup> =>
      Promise.resolve({ ok: true, release: RELEASE }),
    );
    const service = build({ fetchLatest, intervalMs: 1000, launchDelayMs: 10 });

    service.start(false);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchLatest).not.toHaveBeenCalled();
    // …but a MANUAL check still works: the switch governs what the app does by
    // itself, not what the user may ask for.
    await service.check();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('schedules nothing in an unpackaged build even when the setting is on', async () => {
    vi.useFakeTimers();
    const fetchLatest = vi.fn();
    const service = build({
      isPackaged: () => false,
      fetchLatest,
      intervalMs: 1000,
      launchDelayMs: 10,
    });

    service.start(true);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchLatest).not.toHaveBeenCalled();
  });
});
