import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Session } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  downloads: '',
  defaultSession: {
    setProxy: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    on: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mocks.downloads) },
  session: { defaultSession: mocks.defaultSession },
}));

import {
  chatPartition,
  configureBrowserSession,
  ownCookiePartition,
  PARTITION_DIR_PREFIX,
  runStillExists,
  sweepOrphanedBrowserPartitions,
} from './browser-sessions';

type PermissionRequestHandler = (
  contents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
) => void;

class FakeSession extends EventEmitter {
  setProxy = vi.fn((_config: unknown): Promise<void> => Promise.resolve());
  setPermissionRequestHandler =
    vi.fn<(handler: PermissionRequestHandler) => void>();
  setPermissionCheckHandler = vi.fn<(handler: () => boolean) => void>();
  setDevicePermissionHandler = vi.fn<(handler: () => boolean) => void>();
}

const asSession = (fake: FakeSession): Session => fake as unknown as Session;

class FakeDownload extends EventEmitter {
  setSavePath = vi.fn<(path: string) => void>();
  constructor(private readonly filename: string) {
    super();
  }
  getFilename(): string {
    return this.filename;
  }
}

const startDownload = (fake: FakeSession, filename: string): FakeDownload => {
  const item = new FakeDownload(filename);
  fake.emit('will-download', {}, item);
  return item;
};

let scratch: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-browser-')));
  mocks.downloads = join(scratch, 'Downloads');
  mkdirSync(mocks.downloads);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('partition names', () => {
  it('names a chat jar persistent and an own-cookie session in memory, both under the sweep prefix', () => {
    expect(chatPartition('run-1')).toBe('persist:geniro-browser-run-1');
    expect(ownCookiePartition('abc')).toBe('geniro-browser-own-abc');
    expect(PARTITION_DIR_PREFIX).toBe('geniro-browser-');
  });
});

describe('configureBrowserSession', () => {
  it('points the session at the egress proxy with <-loopback> before any load', async () => {
    const fake = new FakeSession();
    let release: () => void = () => undefined;
    fake.setProxy.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    let settled = false;
    const configuring = configureBrowserSession(asSession(fake), 4242).then(
      () => {
        settled = true;
      },
    );

    expect(fake.setProxy).toHaveBeenCalledTimes(1);
    expect(fake.setProxy).toHaveBeenCalledWith({
      proxyRules: 'http://127.0.0.1:4242',
      proxyBypassRules: '<-loopback>',
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await configuring;
    expect(settled).toBe(true);
  });

  it('denies every permission', async () => {
    const fake = new FakeSession();
    await configureBrowserSession(asSession(fake), 1);

    const requestHandler = fake.setPermissionRequestHandler.mock.calls[0]![0];
    for (const permission of ['geolocation', 'media', 'notifications']) {
      const callback = vi.fn();
      requestHandler({}, permission, callback);
      expect(callback, permission).toHaveBeenCalledWith(false);
    }
    expect(fake.setPermissionCheckHandler.mock.calls[0]![0]()).toBe(false);
    expect(fake.setDevicePermissionHandler.mock.calls[0]![0]()).toBe(false);
  });

  it('saves downloads under a unique name in Downloads', async () => {
    const fake = new FakeSession();
    await configureBrowserSession(asSession(fake), 1);
    writeFileSync(join(mocks.downloads, 'report.pdf'), 'x');
    writeFileSync(join(mocks.downloads, 'report (1).pdf'), 'x');

    const taken = startDownload(fake, 'report.pdf');
    const free = startDownload(fake, 'notes.txt');

    expect(taken.setSavePath).toHaveBeenCalledWith(
      join(mocks.downloads, 'report (2).pdf'),
    );
    expect(free.setSavePath).toHaveBeenCalledWith(
      join(mocks.downloads, 'notes.txt'),
    );
  });

  it('gives two downloads of one name that are still in flight two different names', async () => {
    const fake = new FakeSession();
    await configureBrowserSession(asSession(fake), 1);

    const first = startDownload(fake, 'a.zip');
    const second = startDownload(fake, 'a.zip');

    expect(first.setSavePath).toHaveBeenCalledWith(
      join(mocks.downloads, 'a.zip'),
    );
    expect(second.setSavePath).toHaveBeenCalledWith(
      join(mocks.downloads, 'a (1).zip'),
    );

    first.emit('done');
    const third = startDownload(fake, 'a.zip');
    expect(third.setSavePath).toHaveBeenCalledWith(
      join(mocks.downloads, 'a.zip'),
    );
  });

  it('keeps a download whose name carries a path inside Downloads', async () => {
    const fake = new FakeSession();
    await configureBrowserSession(asSession(fake), 1);

    const item = startDownload(fake, '../../evil.txt');

    expect(item.setSavePath).toHaveBeenCalledWith(
      join(mocks.downloads, 'evil.txt'),
    );
  });

  it('configures a session once however many times it is asked', async () => {
    const fake = new FakeSession();

    await Promise.all([
      configureBrowserSession(asSession(fake), 1),
      configureBrowserSession(asSession(fake), 1),
    ]);
    await configureBrowserSession(asSession(fake), 1);

    expect(fake.setProxy).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount('will-download')).toBe(1);
  });

  it('lets a session whose proxy could not be set be configured again, with no policy applied meanwhile', async () => {
    const fake = new FakeSession();
    fake.setProxy.mockRejectedValueOnce(new Error('proxy refused'));

    await expect(configureBrowserSession(asSession(fake), 1)).rejects.toThrow(
      'proxy refused',
    );
    expect(fake.listenerCount('will-download')).toBe(0);

    await configureBrowserSession(asSession(fake), 1);
    expect(fake.setProxy).toHaveBeenCalledTimes(2);
    expect(fake.listenerCount('will-download')).toBe(1);
  });

  it('leaves session.defaultSession on the black hole', async () => {
    const fake = new FakeSession();

    await configureBrowserSession(asSession(fake), 1);

    const touched = Object.values(mocks.defaultSession).flatMap(
      (spy) => spy.mock.calls,
    );
    expect(touched).toEqual([]);
  });
});

describe('sweepOrphanedBrowserPartitions', () => {
  const partitions = (): string => join(scratch, 'userData', 'Partitions');
  const makeJar = (name: string): void => {
    mkdirSync(join(partitions(), name), { recursive: true });
    writeFileSync(join(partitions(), name, 'Cookies'), 'x');
  };

  it('removes only orphaned chat partitions', async () => {
    makeJar('geniro-browser-keep');
    makeJar('geniro-browser-orphan');
    makeJar('geniro-browser-own-leftover');
    makeJar('someone-else');
    mkdirSync(join(scratch, 'userData', 'geniro-browser-outside'));
    const asked: string[] = [];

    const removed = await sweepOrphanedBrowserPartitions(
      join(scratch, 'userData'),
      (runId) => {
        asked.push(runId);
        return runId === 'keep';
      },
    );

    expect(removed).toEqual(['geniro-browser-orphan']);
    expect(readdirSync(partitions()).sort()).toEqual([
      'geniro-browser-keep',
      'geniro-browser-own-leftover',
      'someone-else',
    ]);
    expect(
      existsSync(join(scratch, 'userData', 'geniro-browser-outside')),
    ).toBe(true);
    expect(asked.sort()).toEqual(['keep', 'orphan']);
  });

  it('answers an empty list when there is no Partitions folder', async () => {
    mkdirSync(join(scratch, 'userData'));

    expect(
      await sweepOrphanedBrowserPartitions(
        join(scratch, 'userData'),
        () => false,
      ),
    ).toEqual([]);
  });

  it('never asks about, or removes, the bare prefix', async () => {
    mkdirSync(join(partitions(), 'geniro-browser-'), { recursive: true });
    const keep = vi.fn(() => false);

    const removed = await sweepOrphanedBrowserPartitions(
      join(scratch, 'userData'),
      keep,
    );

    expect(removed).toEqual([]);
    expect(keep).not.toHaveBeenCalled();
    expect(existsSync(join(partitions(), 'geniro-browser-'))).toBe(true);
  });
});

describe('runStillExists', () => {
  const handle = { host: '127.0.0.1', port: 4100, token: 'tok' };
  const answering =
    (status: number): typeof fetch =>
    () =>
      Promise.resolve(new Response(null, { status }));

  it("lets a jar go only on the daemon's 404 for its run", async () => {
    const asked: string[] = [];
    const recording: typeof fetch = (input, init) => {
      asked.push(
        `${String(input)} ${new Headers(init?.headers).get('authorization')}`,
      );
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    await expect(runStillExists(handle, 'run-1', recording)).resolves.toBe(
      false,
    );
    expect(asked).toEqual([
      'http://127.0.0.1:4100/v1/chats/run-1/state Bearer tok',
    ]);
  });

  it('keeps a jar on any other answer or a failed read', async () => {
    await expect(runStillExists(handle, 'r', answering(200))).resolves.toBe(
      true,
    );
    await expect(runStillExists(handle, 'r', answering(500))).resolves.toBe(
      true,
    );
    await expect(
      runStillExists(handle, 'r', () =>
        Promise.reject(new Error('daemon gone')),
      ),
    ).resolves.toBe(true);
  });
});
