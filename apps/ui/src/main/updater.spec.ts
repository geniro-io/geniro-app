import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchLatestRelease, isNewerVersion, parseVersion } from './updater';

function feedResponse(
  body: unknown,
  { ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function asset(name: string): Record<string, string> {
  return {
    name,
    browser_download_url: `https://example.test/download/${name}`,
  };
}

/** One entry of the release list, shaped as GitHub sends it. */
function release(
  tag: string,
  assets: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { tag_name: tag, assets: assets.map(asset), ...extra };
}

/** The macOS pair a finished build attaches, for the version in `tag`. */
function macAssets(version: string): string[] {
  return [
    `Geniro-${version}-arm64.dmg`,
    `Geniro-${version}-arm64-mac.zip`,
    'SHA256SUMS.txt',
  ];
}

function mockFetch(impl: () => Promise<Response> | Response): void {
  vi.stubGlobal('fetch', vi.fn(impl) as unknown as typeof fetch);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isNewerVersion', () => {
  it('compares numerically, not lexically (1.10.0 > 1.9.0)', () => {
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
    expect(isNewerVersion('1.9.0', '1.10.0')).toBe(false);
  });

  it('never offers a downgrade or a re-install of the running version', () => {
    expect(isNewerVersion('0.9.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
  });

  it('refuses to update when either version is unparseable', () => {
    // "We cannot tell" must read as "do not replace the app", not as an
    // update: this is the only guard between a malformed tag and a swap.
    expect(isNewerVersion('not-a-version', '1.0.0')).toBe(false);
    expect(isNewerVersion('2.0.0', 'nightly')).toBe(false);
  });

  it('tolerates the tag feed’s leading v', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(isNewerVersion('v1.2.3', '1.2.2')).toBe(true);
  });
});

describe('fetchLatestRelease', () => {
  it('resolves the version, the macOS zip and the checksum file', async () => {
    mockFetch(() => feedResponse([release('v1.4.0', macAssets('1.4.0'))]));

    const lookup = await fetchLatestRelease();

    expect(lookup).toEqual({
      ok: true,
      release: {
        version: '1.4.0',
        zip: {
          name: 'Geniro-1.4.0-arm64-mac.zip',
          url: 'https://example.test/download/Geniro-1.4.0-arm64-mac.zip',
        },
        checksums: {
          name: 'SHA256SUMS.txt',
          url: 'https://example.test/download/SHA256SUMS.txt',
        },
      },
    });
  });

  it('picks the zip over the dmg — the dmg is not what gets swapped in', async () => {
    mockFetch(() =>
      feedResponse([
        release('v2.0.0', [
          'Geniro-2.0.0-arm64.dmg',
          'Geniro-2.0.0-arm64-mac.zip',
        ]),
      ]),
    );

    const lookup = await fetchLatestRelease();

    expect(lookup.ok && lookup.release.zip.name).toBe(
      'Geniro-2.0.0-arm64-mac.zip',
    );
  });

  it('reports a release with no checksum file as one, rather than hiding it', async () => {
    mockFetch(() =>
      feedResponse([release('v1.4.0', ['Geniro-1.4.0-arm64-mac.zip'])]),
    );

    const lookup = await fetchLatestRelease();

    // The lookup still succeeds — the REFUSAL belongs to the installer, which
    // is the only place that knows the digest is load-bearing. Surfacing it as
    // a failed check here would hide a real release from the user.
    expect(lookup.ok && lookup.release.checksums).toBeNull();
  });

  it('offers the newest release that HAS an archive, not the newest release', async () => {
    // The four-minute window after every release: the tag is cut and the
    // release published, and the macOS build attaches the archive minutes
    // later. Reverting to reading only the newest entry fails here — the
    // lookup goes back to `ok: false` and the user is shown an error about a
    // release that is merely still building.
    mockFetch(() =>
      feedResponse([
        release('v1.48.4', []),
        release('v1.48.3', macAssets('1.48.3')),
      ]),
    );

    const lookup = await fetchLatestRelease();

    expect(lookup.ok && lookup.release.version).toBe('1.48.3');
  });

  it('skips drafts and pre-releases, which /releases/latest used to filter', async () => {
    mockFetch(() =>
      feedResponse([
        release('v2.0.0', macAssets('2.0.0'), { draft: true }),
        release('v1.9.0', macAssets('1.9.0'), { prerelease: true }),
        release('v1.8.0', macAssets('1.8.0')),
      ]),
    );

    const lookup = await fetchLatestRelease();

    expect(lookup.ok && lookup.release.version).toBe('1.8.0');
  });

  it('orders by VERSION, not by the feed’s order', async () => {
    // GitHub lists by tag date, and `1.10.0` sorts before `1.9.0` in any
    // string comparison — so the newest must be chosen the same numeric way
    // `isNewerVersion` decides whether to offer it at all.
    mockFetch(() =>
      feedResponse([
        release('v1.9.0', macAssets('1.9.0')),
        release('v1.10.0', macAssets('1.10.0')),
      ]),
    );

    const lookup = await fetchLatestRelease();

    expect(lookup.ok && lookup.release.version).toBe('1.10.0');
  });

  it('fails when NO release publishes a macOS archive', async () => {
    mockFetch(() =>
      feedResponse([
        release('v1.4.0', ['notes.txt']),
        release('v1.3.0', ['notes.txt']),
      ]),
    );

    const lookup = await fetchLatestRelease();

    expect(lookup).toEqual({
      ok: false,
      error: 'no published release carries a macOS archive',
    });
  });

  it('sends a User-Agent (GitHub rejects the API without one)', async () => {
    let sentHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        sentHeaders = init?.headers as Record<string, string>;
        return Promise.resolve(
          feedResponse([release('v1.0.0', macAssets('1.0.0'))]),
        );
      }) as unknown as typeof fetch,
    );

    await fetchLatestRelease();

    expect(sentHeaders?.['User-Agent']).toBeTruthy();
  });

  it('maps a non-OK feed response to a structured error, never a throw', async () => {
    mockFetch(() => feedResponse({}, { ok: false, status: 503 }));

    const lookup = await fetchLatestRelease();

    expect(lookup).toEqual({
      ok: false,
      error: 'release feed returned HTTP 503',
    });
  });

  it('maps a network failure to a structured error, never a throw', async () => {
    mockFetch(() => {
      throw new Error('network down');
    });

    const lookup = await fetchLatestRelease();

    expect(lookup.ok).toBe(false);
    expect(!lookup.ok && lookup.error).toContain('network down');
  });

  it('maps an unreadable tag to a structured error', async () => {
    mockFetch(() =>
      feedResponse([{ tag_name: 42, assets: [asset('Geniro-x-mac.zip')] }]),
    );

    const lookup = await fetchLatestRelease();

    // A release whose version cannot be parsed is one this app cannot compare
    // against its own, so it is not a candidate however many assets it has.
    expect(lookup).toEqual({
      ok: false,
      error: 'no published release carries a macOS archive',
    });
  });

  it('maps a feed that is not a list to a structured error', async () => {
    // The shape `/releases/latest` returns, in case the endpoint is ever
    // changed back by hand: a single object is not something to iterate.
    mockFetch(() => feedResponse({ tag_name: 'v1.4.0', assets: [] }));

    const lookup = await fetchLatestRelease();

    expect(lookup).toEqual({
      ok: false,
      error: 'could not read the release feed',
    });
  });
});
