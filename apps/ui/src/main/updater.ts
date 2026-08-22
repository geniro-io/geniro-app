/**
 * The release feed — what versions exist, and which files carry them.
 *
 * This half only READS github.com. Deciding whether a release is worth taking
 * is `update-service.ts`, and swapping the bundle is `update-installer.ts`;
 * keeping the network shape here means the service can be driven in a spec
 * with a hand-written release and no fetch at all.
 *
 * The app is signed with Geniro's own self-signed certificate and is NOT
 * notarized (no Apple Developer ID), so Gatekeeper has no verdict it will act
 * on: the cask and install script strip quarantine, and nothing between the
 * release that was built and the code about to execute as the user is checked
 * by the system. What replaces it is the install script's own sequence, moved
 * into the app: resolve the release, download the zip, verify it against the
 * published checksum, swap the bundle. The checksum is not belt-and-braces
 * there — it is the ONLY thing standing between a tampered download and an
 * executing app.
 *
 * electron-updater stays out for the same reason it always did, minus one
 * argument that has since expired. Its macOS path is Squirrel.Mac, which
 * validates a downloaded bundle against the RUNNING app's designated
 * requirement; that used to be an ad-hoc `cdhash` no later build could ever
 * match, and since the release certificate landed (`scripts/build-mac.mjs`) it
 * is a stable expression naming that certificate — so the blocker is now a
 * choice rather than an impossibility. What is left is that this path already
 * exists, verifies its own downloads, and handles the cases Squirrel does not
 * know about here (a translocated or read-only install → `brew upgrade`).
 */

/**
 * The release LIST, not `/releases/latest`.
 *
 * "Latest" and "latest one this app can install" are not the same release, and
 * the gap is a normal part of every release rather than a malfunction: the
 * workflow publishes the release seconds after the tag is cut and only then
 * starts the macOS build that attaches the archive. Measured on the v1.48.4
 * run — the release existed 14s in, the archive landed ~4 minutes later — and
 * for those four minutes `/releases/latest` answered with a release carrying
 * no assets at all. The app polls every 5 minutes, so it reliably looked
 * inside that window and told the user, in red, that it could not update.
 *
 * Reading the list is what lets the check see PAST a release it cannot use —
 * to the one before it, which it can. It costs the same single request against
 * the same 60/hour unauthenticated budget.
 */
const RELEASES_API =
  'https://api.github.com/repos/geniro-io/geniro-app/releases?per_page=10';
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
  | {
      ok: true;
      release: LatestRelease;
      /**
       * The newest version the feed PUBLISHES, installable or not.
       *
       * Not the same question as {@link release}, and the difference is the
       * whole reason this exists: publishing a release and uploading its macOS
       * archive are two steps, so between them the newest tag carries nothing
       * to install. The caller offering only `release` then had no way to tell
       * "you are on the latest" apart from "the latest is not downloadable
       * yet", and said the first about both — REPORTED as "terminal not saying
       * truth, there is a new version".
       *
       * Null only for a feed with no usable tag at all.
       */
      published: string | null;
    }
  | { ok: false; error: string };

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
 * The version of a release this app would CONSIDER — published (not a draft,
 * not a pre-release) with a readable tag — whether or not anything on it can be
 * installed.
 *
 * Split out of {@link readRelease} so the two questions stay separable: which
 * release can be installed, and which version exists. Folded together they were
 * indistinguishable, and a tag whose archive had not been uploaded yet was
 * silently read as no tag at all.
 */
function readPublishedVersion(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const {
    tag_name: tag,
    draft,
    prerelease,
  } = value as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
  if (draft === true || prerelease === true) {
    return null;
  }
  const version = typeof tag === 'string' ? parseVersion(tag) : null;
  return version ? version.join('.') : null;
}

/**
 * One entry of the release list, reduced to what an update needs — or null if
 * this app could not act on it.
 *
 * Four ways to be unusable, and they are deliberately not distinguished HERE:
 * a draft, a pre-release, an unreadable tag, and a release carrying no macOS
 * archive all mean the same thing to a caller looking for something to install.
 * The first two are the filtering `/releases/latest` used to do for us. The
 * fourth is told apart one level up, by {@link readPublishedVersion}, because
 * it is the only one of the four that means "come back in a minute".
 */
function readRelease(value: unknown): LatestRelease | null {
  const version = readPublishedVersion(value);
  if (!version) {
    return null;
  }
  const { assets: rawAssets } = value as { assets?: unknown };
  const assets = Array.isArray(rawAssets)
    ? rawAssets.map(readAsset).filter((a): a is ReleaseAsset => a !== null)
    : [];
  const zip = assets.find((a) => a.name.endsWith('-mac.zip'));
  if (!zip) {
    return null;
  }
  return {
    version,
    zip,
    checksums: assets.find((a) => a.name === 'SHA256SUMS.txt') ?? null,
  };
}

/**
 * The newest release this app can actually install, or why there is none.
 *
 * "Newest" is decided by comparing VERSIONS rather than by trusting the feed's
 * order, which is by tag date — the same rule {@link isNewerVersion} applies,
 * so the release offered here and the decision to offer it cannot disagree.
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

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!Array.isArray(body)) {
    return { ok: false, error: 'could not read the release feed' };
  }

  // Both questions, off the same page: what is the newest tag, and what is the
  // newest tag this app can actually install. They differ for exactly as long
  // as a release's macOS archive takes to upload.
  const published = body
    .map(readPublishedVersion)
    .filter((v): v is string => v !== null)
    .reduce<string | null>(
      (best, version) =>
        best === null || isNewerVersion(version, best) ? version : best,
      null,
    );
  const installable = body
    .map(readRelease)
    .filter((r): r is LatestRelease => r !== null);
  // The MAX, taken directly rather than by sorting: a comparator built on
  // `isNewerVersion` has no way to say "equal", and one that answers "after"
  // to both `(a,b)` and `(b,a)` is not an ordering a sort may be handed.
  const newest = installable.reduce<LatestRelease | null>(
    (best, release) =>
      best === null || isNewerVersion(release.version, best.version)
        ? release
        : best,
    null,
  );
  if (!newest) {
    // Every release in the page is a draft, a pre-release, or carries no app
    // archive. Named rather than reported as "no update", which would leave a
    // user on an old version with nothing to act on — the distinction the
    // per-release check no longer has to make on its own, now that ONE bad
    // release is answered by offering the newest good one instead.
    return {
      ok: false,
      // Naming the tag when there is one: "no release carries an archive" and
      // "v0.2.0's archive is still uploading" send the user to different
      // places, and only the second is worth waiting out.
      error:
        published === null
          ? 'no published release carries a macOS archive'
          : `Geniro ${published} is published, but carries no macOS archive`,
    };
  }

  return { ok: true, release: newest, published };
}
