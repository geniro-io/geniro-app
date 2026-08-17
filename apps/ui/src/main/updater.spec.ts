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
    mockFetch(() =>
      feedResponse({
        tag_name: 'v1.4.0',
        assets: [
          asset('Geniro-1.4.0-arm64.dmg'),
          asset('Geniro-1.4.0-arm64-mac.zip'),
          asset('SHA256SUMS.txt'),
        ],
      }),
    );

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
      feedResponse({
        tag_name: 'v2.0.0',
        assets: [
          asset('Geniro-2.0.0-arm64.dmg'),
          asset('Geniro-2.0.0-arm64-mac.zip'),
        ],
      }),
    );

    const lookup = await fetchLatestRelease();

    expect(lookup.ok && lookup.release.zip.name).toBe(
      'Geniro-2.0.0-arm64-mac.zip',
    );
  });

  it('reports a release with no checksum file as one, rather than hiding it', async () => {
    mockFetch(() =>
      feedResponse({
        tag_name: 'v1.4.0',
        assets: [asset('Geniro-1.4.0-arm64-mac.zip')],
      }),
    );

    const lookup = await fetchLatestRelease();

    // The lookup still succeeds — the REFUSAL belongs to the installer, which
    // is the only place that knows the digest is load-bearing. Surfacing it as
    // a failed check here would hide a real release from the user.
    expect(lookup.ok && lookup.release.checksums).toBeNull();
  });

  it('fails a release that publishes no macOS archive', async () => {
    mockFetch(() =>
      feedResponse({ tag_name: 'v1.4.0', assets: [asset('notes.txt')] }),
    );

    const lookup = await fetchLatestRelease();

    expect(lookup).toEqual({
      ok: false,
      error: 'release v1.4.0 publishes no macOS archive',
    });
  });

  it('sends a User-Agent (GitHub rejects the API without one)', async () => {
    let sentHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        sentHeaders = init?.headers as Record<string, string>;
        return Promise.resolve(
          feedResponse({ tag_name: 'v1.0.0', assets: [] }),
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
    mockFetch(() => feedResponse({ tag_name: 42, assets: [] }));

    const lookup = await fetchLatestRelease();

    expect(lookup).toEqual({
      ok: false,
      error: 'could not read the latest release version',
    });
  });
});
