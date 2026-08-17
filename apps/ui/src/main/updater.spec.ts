import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false, getVersion: vi.fn(() => '1.0.0') },
}));

vi.mock('electron', () => ({ app: mocks.app }));

import { checkForUpdates, checkOnLaunch, UPDATE_COMMAND } from './updater';

function mockFetch(impl: (url: string) => Promise<Response> | Response): void {
  vi.stubGlobal('fetch', vi.fn(impl as typeof fetch));
}

function releaseResponse(tag: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => ({ tag_name: tag }),
  } as unknown as Response;
}

/** The tap's cask file, as raw.githubusercontent serves it. */
function caskResponse(version: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () =>
      `cask "geniro" do\n  version "${version}"\n  sha256 "x"\nend\n`,
  } as unknown as Response;
}

/**
 * Answer BOTH endpoints the check reads, by URL.
 *
 * `cask: null` is a tap that will not answer — the fallback path — rather than
 * a tap serving nothing, which is a different fact and a different verdict.
 */
function mockChannels(release: string, cask: string | null): void {
  mockFetch((url) =>
    String(url).includes('homebrew-tap')
      ? cask === null
        ? Promise.reject(new Error('tap unreachable'))
        : Promise.resolve(caskResponse(cask))
      : Promise.resolve(releaseResponse(release)),
  );
}

beforeEach(() => {
  mocks.app.isPackaged = false;
  mocks.app.getVersion.mockReturnValue('1.0.0');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkForUpdates', () => {
  it('short-circuits in dev without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await checkForUpdates();

    expect(result.status).toBe('dev');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports an available update and names the update command', async () => {
    mocks.app.isPackaged = true;
    mockChannels('v1.1.0', '1.1.0');

    const result = await checkForUpdates();

    expect(result.status).toBe('available');
    expect(result.version).toBe('1.1.0');
    expect(result.message).toContain(UPDATE_COMMAND);
  });

  it('stays quiet while a published release is not yet installable', async () => {
    mocks.app.isPackaged = true;
    // The real window between `create-release` and `bump-cask`: the feed names
    // 1.1.0, the cask still serves 1.0.0, and `brew upgrade --cask geniro`
    // therefore does nothing — which is what the banner used to send the user
    // off to run.
    mockChannels('v1.1.0', '1.0.0');

    const result = await checkForUpdates();

    expect(result.status).toBe('up-to-date');
  });

  it('announces the CASK version once the tap catches up, not the feed', async () => {
    mocks.app.isPackaged = true;
    // A tap that is AHEAD of `/releases/latest` (a re-cut release, a feed
    // cache): the version named must still be the one brew would install.
    mockChannels('v1.1.0', '1.2.0');

    const result = await checkForUpdates();

    expect(result).toMatchObject({ status: 'available', version: '1.2.0' });
  });

  it('falls back to the release feed when the tap cannot be read', async () => {
    mocks.app.isPackaged = true;
    mockChannels('v1.1.0', null);

    const result = await checkForUpdates();

    // A machine that cannot reach the tap must not be told it is up to date —
    // that is a silenced update, not a verified one.
    expect(result).toMatchObject({ status: 'available', version: '1.1.0' });
  });

  it('reports up-to-date when the latest release matches the running version', async () => {
    mocks.app.isPackaged = true;
    mockFetch(() => releaseResponse('v1.0.0'));

    const result = await checkForUpdates();

    expect(result).toEqual({
      status: 'up-to-date',
      version: '1.0.0',
      message: null,
    });
  });

  it('does NOT offer a downgrade when the feed is older than the running app', async () => {
    mocks.app.isPackaged = true;
    mockFetch(() => releaseResponse('v0.9.0'));

    const result = await checkForUpdates();

    // An ad-hoc install never auto-downgrades; an older release is just
    // "up to date" from the app's perspective (nothing to pull).
    expect(result.status).toBe('up-to-date');
  });

  it('compares versions numerically, not lexically (v1.10.0 > v1.9.0)', async () => {
    mocks.app.isPackaged = true;
    mocks.app.getVersion.mockReturnValue('1.9.0');
    mockFetch(() => releaseResponse('v1.10.0'));

    const result = await checkForUpdates();

    expect(result.status).toBe('available');
    expect(result.version).toBe('1.10.0');
  });

  it('sends a User-Agent (GitHub rejects the API without one)', async () => {
    mocks.app.isPackaged = true;
    let sentHeaders: Record<string, string> | undefined;
    mockFetch((_url) => releaseResponse('v1.0.0'));
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        sentHeaders = init?.headers as Record<string, string>;
        return Promise.resolve(releaseResponse('v1.0.0'));
      }) as typeof fetch,
    );

    await checkForUpdates();

    expect(sentHeaders?.['User-Agent']).toBeTruthy();
  });

  it('maps a non-OK feed response to a structured error, never a throw', async () => {
    mocks.app.isPackaged = true;
    mockFetch(() => releaseResponse('v1.1.0', false, 503));

    const result = await checkForUpdates();

    expect(result.status).toBe('error');
    expect(result.message).toContain('503');
  });

  it('maps a network failure to a structured error, never a throw', async () => {
    mocks.app.isPackaged = true;
    mockFetch(() => {
      throw new Error('network down');
    });

    const result = await checkForUpdates();

    expect(result.status).toBe('error');
    expect(result.message).toContain('network down');
  });
});

describe('checkOnLaunch', () => {
  it('does nothing when the settings toggle is off', () => {
    mocks.app.isPackaged = true;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    checkOnLaunch(false);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fires the check when enabled on a packaged app', async () => {
    mocks.app.isPackaged = true;
    const fetchSpy = vi.fn(() => Promise.resolve(releaseResponse('v1.0.0')));
    vi.stubGlobal('fetch', fetchSpy as typeof fetch);

    checkOnLaunch(true);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  });
});
