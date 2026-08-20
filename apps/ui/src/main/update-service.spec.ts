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

interface LogLine {
  level: string;
  message: string;
  context: Record<string, string>;
}

let broadcasts: UpdateState[];
let installed: InstallInput[];
let relaunched: number;
let swept: { workDir: string; bundlePath: string }[];
let logged: LogLine[];

function build(overrides: Partial<UpdateServiceDeps> = {}): UpdateService {
  broadcasts = [];
  installed = [];
  relaunched = 0;
  swept = [];
  logged = [];
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
    sweep: (input) => {
      swept.push(input);
      return Promise.resolve([]);
    },
    relaunch: () => {
      relaunched += 1;
    },
    broadcast: (state) => broadcasts.push(state),
    log: (level, message, context) => logged.push({ level, message, context }),
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

describe('UpdateService deadlines', () => {
  /**
   * REPORTED: the app sat on one non-terminal phase and never left it. Main
   * owns this state and pushes it at every window, so reloading the renderer
   * only re-read the same wedged value — the only recourse was quitting the
   * app, which nothing anywhere tells the user. These four pin the escape.
   */
  it('gives up on a check that never answers, instead of holding `checking` for the rest of the launch', async () => {
    vi.useFakeTimers();
    let hang = true;
    let answer!: (lookup: ReleaseLookup) => void;
    const service = build({
      checkDeadlineMs: 1000,
      fetchLatest: () =>
        hang
          ? new Promise<ReleaseLookup>((resolve) => {
              answer = resolve;
            })
          : Promise.resolve({ ok: true, release: RELEASE }),
    });

    void service.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getState().phase).toBe('checking');

    await vi.advanceTimersByTimeAsync(1000);
    expect(service.getState().phase).toBe('error');
    expect(service.getState().message).toContain('did not finish');

    // The abandoned call answering late must not overwrite the failure the
    // user has already been shown — and may already have acted on.
    answer({ ok: true, release: RELEASE });
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getState().phase).toBe('error');

    // …while the latch is free, so the app is usable again without a quit.
    hang = false;
    expect((await service.check()).phase).toBe('available');
  });

  it('re-arms the download budget on every chunk, then gives up once nothing more arrives', async () => {
    vi.useFakeTimers();
    let tick!: () => void;
    const service = build({
      downloadStallMs: 1000,
      install: ({ onProgress }) => {
        // A transfer the server declared no length for: `fraction` stays null
        // the whole way, so a budget re-armed off the PUBLISHED progress —
        // which never changes here — would give up on a healthy stream.
        tick = () =>
          onProgress?.({ fraction: null, receivedBytes: 1, totalBytes: null });
        return new Promise<void>(() => {});
      },
    });
    await service.check();

    void service.install();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getState().phase).toBe('downloading');

    await vi.advanceTimersByTimeAsync(800);
    tick();
    await vi.advanceTimersByTimeAsync(800);
    // 1600ms in on a 1000ms budget, and still going: the chunk moved it.
    expect(service.getState().phase).toBe('downloading');

    // The SECOND chunk changes no published progress at all — null was already
    // broadcast by the first — so this is the tick a budget re-armed off the
    // emitted state would miss, giving up at 1800ms on a live download.
    tick();
    await vi.advanceTimersByTimeAsync(800);
    expect(service.getState().phase).toBe('downloading');
    expect(
      broadcasts.filter(
        (b) => b.phase === 'downloading' && b.progress === null,
      ),
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(service.getState()).toMatchObject({
      phase: 'error',
      progress: null,
    });
    expect(service.getState().message).toContain('made no progress');
    expect(service.getState().message).toContain(UPDATE_COMMAND);
  });

  it('hands `installing` a budget of its own — a swap reports no progress to re-arm with', async () => {
    vi.useFakeTimers();
    const service = build({
      downloadStallMs: 1000,
      installDeadlineMs: 5000,
      install: ({ onStage }) => {
        onStage?.('installing');
        return new Promise<void>(() => {});
      },
    });
    await service.check();

    void service.install();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getState().phase).toBe('installing');

    // Well past the download's stall budget, which no longer applies.
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.getState().phase).toBe('installing');

    await vi.advanceTimersByTimeAsync(4000);
    expect(service.getState().phase).toBe('error');
    expect(service.getState().message).toContain('installing did not finish');
  });

  it('CANCELS the attempt it abandons, and refuses the answer it eventually gives', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    const service = build({
      downloadStallMs: 1000,
      install: (input) => {
        signal = input.signal;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    await service.check();

    void service.install();
    await vi.advanceTimersByTimeAsync(1000);

    expect(service.getState().phase).toBe('error');
    // Ignoring a wedged install is not enough: the user can retry the moment
    // the app frees up, and a swap still running underneath would be a second
    // `ditto` writing the same bundle.
    expect(signal?.aborted).toBe(true);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getState().phase).toBe('error');
    expect(relaunched).toBe(0);
  });
});

describe('UpdateService retry', () => {
  it('retries the release the user was offered when the first attempt failed', async () => {
    let attempts = 0;
    const service = build({
      install: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('network down');
        }
      },
    });
    await service.check();
    expect((await service.install()).phase).toBe('error');

    // The rail's Retry control IS this call, and by then the phase is `error`.
    // A guard that accepted `available` alone made that button do nothing but
    // restate its own refusal.
    const state = await service.install();

    expect(attempts).toBe(2);
    expect(state).toMatchObject({ phase: 'ready', currentVersion: '1.4.0' });
  });

  it('refuses a retry when the failure was a CHECK — there is no release to install', async () => {
    const service = build({
      fetchLatest: () => Promise.resolve({ ok: false, error: 'HTTP 503' }),
    });
    await service.check();
    expect(service.getState().phase).toBe('error');

    // Accepting `error` widened the door only for an attempt that had
    // something to install; a check that failed never held a release, and
    // "install whatever is latest" is not what the user pressed.
    expect((await service.install()).message).toBe(
      'there is no update ready to install',
    );
    expect(installed).toHaveLength(0);
  });
});

describe('UpdateService.sweepDebris', () => {
  it('clears what previous updates left on disk, and says where it can be read back', async () => {
    const service = build({
      sweep: (input) => {
        swept.push(input);
        return Promise.resolve([
          '/tmp/updates/update-aaa',
          '/Applications/Geniro.app.old-111',
        ]);
      },
    });

    expect(await service.sweepDebris()).toHaveLength(2);
    expect(swept).toEqual([
      { workDir: '/tmp/updates', bundlePath: '/Applications/Geniro.app' },
    ]);
    expect(logged.at(-1)?.message).toContain('Geniro.app.old-111');
  });

  it('sweeps nothing in an unpackaged build, where no bundle was ever replaced', async () => {
    const service = build({ isPackaged: () => false });

    expect(await service.sweepDebris()).toEqual([]);
    expect(swept).toEqual([]);
  });

  it('will not delete the scratch directory a running download is writing into', async () => {
    const service = build({ install: () => new Promise<void>(() => {}) });
    await service.check();
    void service.install();

    expect(await service.sweepDebris()).toEqual([]);
    expect(swept).toEqual([]);
  });
});

describe('UpdateService reporting', () => {
  it('writes a failed install where the user can actually read it back', async () => {
    // The gap beside the wedge, and why it could not be diagnosed: a packaged
    // Finder launch discards main's stdout, so nothing about a failed update
    // reached any file — the day of the reported failure held no record of it
    // anywhere on the machine.
    const service = build({
      install: () => Promise.reject(new Error('checksum mismatch')),
    });
    await service.check();
    await service.install();

    expect(
      logged.some((l) => l.context.kind === 'update-install-started'),
    ).toBe(true);
    const failure = logged.find(
      (l) => l.context.kind === 'update-install-failed',
    );
    expect(failure?.level).toBe('error');
    expect(failure?.message).toContain('checksum mismatch');
  });

  it('writes the check failure the user never sees a banner for', async () => {
    const service = build({
      fetchLatest: () => Promise.resolve({ ok: false, error: 'HTTP 503' }),
    });

    await service.check();

    // A background check failing is deliberately NOT put in the status row —
    // which leaves the log as the only place it is recorded at all.
    expect(
      logged.find((l) => l.context.kind === 'update-check-failed'),
    ).toMatchObject({ level: 'warn' });
  });
});
