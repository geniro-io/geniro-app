/**
 * The release feed — what versions exist, and which files carry them.
 *
 * This half only READS github.com. Deciding whether a release is worth taking
 * is `update-service.ts`, and swapping the bundle is `update-installer.ts`;
 * keeping the network shape here means the service can be driven in a spec
 * with a hand-written release and no fetch at all.
 *
 * The app is ad-hoc signed (no Apple Developer ID, no notarization), so
 * Squirrel.Mac — and therefore electron-updater over it — is not available: it
 * validates a downloaded bundle against the running app's designated
 * requirement, and an ad-hoc identity's requirement is a `cdhash` no later
 * build can ever match. What replaces it is the install script's own sequence,
 * moved into the app: resolve the release, download the zip, verify it against
 * the published checksum, swap the bundle. The checksum is not belt-and-braces
 * there — with no code signature it is the ONLY thing standing between a
 * tampered download and an executing app.
 */
const RELEASES_API =
  'https://api.github.com/repos/geniro-io/geniro-app/releases/latest';
/**
 * The feed is a metadata call on a fast API; the DOWNLOAD sets its own (much
 * longer) budget. 10s rather than 5 because this now runs unattended on a
 * timer, where a slow network should be retried at the next tick rather than
 * reported as a failed check.
 */
const CHECK_TIMEOUT_MS = 10_000;

/** One downloadable file on a release. */
export interface ReleaseAsset {
  name: string;
  url: string;
}

/** The latest published release, reduced to what an update needs. */
export interface LatestRelease {
  /** Normalized `1.2.3` — the tag's leading `v` is dropped. */
  version: string;
  /** The macOS app archive (`*-mac.zip`); this is what gets swapped in. */
  zip: ReleaseAsset;
  /**
   * `SHA256SUMS.txt`. Absent on releases cut before the app could update
   * itself — which the installer treats as a refusal, not a warning.
   */
  checksums: ReleaseAsset | null;
}

export type ReleaseLookup =
  { ok: true; release: LatestRelease } | { ok: false; error: string };

/** Parse `1.2.3` / `v1.2.3` into a `[major, minor, patch]` tuple, or null. */
export function parseVersion(value: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Is `candidate` a newer release than `current`?
 *
 * Numeric per component, so `1.10.0` beats `1.9.0` — the comparison a string
 * sort gets backwards. An unparseable version on either side answers `false`:
 * refusing to update is the safe reading of "we cannot tell".
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const latest = parseVersion(candidate);
  const running = parseVersion(current);
  if (!latest || !running) {
    return false;
  }
  const [lMaj, lMin, lPatch] = latest;
  const [cMaj, cMin, cPatch] = running;
  if (lMaj !== cMaj) {
    return lMaj > cMaj;
  }
  if (lMin !== cMin) {
    return lMin > cMin;
  }
  return lPatch > cPatch;
}

/** One entry of the GitHub release feed's `assets` array, as far as we read it. */
function readAsset(value: unknown): ReleaseAsset | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { name, browser_download_url: url } = value as {
    name?: unknown;
    browser_download_url?: unknown;
  };
  return typeof name === 'string' && typeof url === 'string'
    ? { name, url }
    : null;
}

/**
 * The newest published release, or why it could not be read.
 *
 * `/releases/latest` already excludes drafts and pre-releases, so the newest
 * stable tag wins with no filtering here.
 */
export async function fetchLatestRelease(): Promise<ReleaseLookup> {
  let res: Response;
  try {
    // GitHub's REST API requires a User-Agent.
    res = await fetch(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'geniro-app',
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!res.ok) {
    return { ok: false, error: `release feed returned HTTP ${res.status}` };
  }

  let body: { tag_name?: unknown; assets?: unknown };
  try {
    body = (await res.json()) as { tag_name?: unknown; assets?: unknown };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const version =
    typeof body.tag_name === 'string' ? parseVersion(body.tag_name) : null;
  if (!version) {
    return { ok: false, error: 'could not read the latest release version' };
  }

  const assets = Array.isArray(body.assets)
    ? body.assets.map(readAsset).filter((a): a is ReleaseAsset => a !== null)
    : [];
  const zip = assets.find((a) => a.name.endsWith('-mac.zip')) ?? null;
  if (!zip) {
    // The release exists but carries no app archive — a build job that failed
    // after the tag was cut. Named as such rather than reported as "no update",
    // which would leave a user on an old version with nothing to act on.
    return {
      ok: false,
      error: `release v${version.join('.')} publishes no macOS archive`,
    };
  }

  return {
    ok: true,
    release: {
      version: version.join('.'),
      zip,
      checksums: assets.find((a) => a.name === 'SHA256SUMS.txt') ?? null,
    },
  };
}
