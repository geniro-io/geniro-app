import { app } from 'electron';

import type { UpdateCheckResult } from '../shared/contracts';

/**
 * Update checker for the ad-hoc (unsigned) distribution model. The app is
 * installed via Homebrew (`brew upgrade --cask geniro`) or the install script,
 * NOT via macOS silent auto-update: the app is unsigned, so there is no code
 * signature a Squirrel-style updater could validate a download against. So this
 * only *reports* whether a newer GitHub release exists and tells the user the
 * one command to run; it never downloads or installs anything.
 */
const RELEASES_API =
  'https://api.github.com/repos/geniro-io/geniro-app/releases/latest';
/**
 * The Homebrew cask — the version a user can actually INSTALL right now.
 *
 * Read alongside the release feed because the two are not the same fact, and
 * announcing the wrong one is the defect this exists to fix. The release
 * workflow publishes the GitHub release FIRST and only then builds the app,
 * attaches the .dmg/.zip and bumps this cask (`.github/workflows/release.yaml`
 * — `create-release` → `build-app` → `bump-cask`), which is a window of ten to
 * twenty minutes in which `/releases/latest` names a version that no channel
 * can install: reported as "the app says a new version is available, but the
 * terminal says it is not", with `brew upgrade --cask geniro` doing nothing.
 *
 * So this file's verdict comes from the channel it RECOMMENDS. The cask is the
 * last step of the release, so it is also the safest single proxy for "the
 * artifacts exist" — the install script's path is bumped by the same event.
 */
const CASK_RAW_URL =
  'https://raw.githubusercontent.com/geniro-io/homebrew-tap/HEAD/Casks/geniro.rb';
const CHECK_TIMEOUT_MS = 5_000;
/** The single command that actually updates an installed app. */
export const UPDATE_COMMAND = 'brew upgrade --cask geniro';

/** Parse `1.2.3` / `v1.2.3` into a `[major, minor, patch]` tuple, or null. */
function parseVersion(value: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(
  [lMaj, lMin, lPatch]: [number, number, number],
  [cMaj, cMin, cPatch]: [number, number, number],
): boolean {
  if (lMaj !== cMaj) {
    return lMaj > cMaj;
  }
  if (lMin !== cMin) {
    return lMin > cMin;
  }
  return lPatch > cPatch;
}

/**
 * The version the Homebrew cask currently serves, or null when it cannot be
 * read (tap offline, moved, or a cask this parser does not recognise).
 *
 * Null is "unknown", never "nothing to install": the caller falls back to the
 * release feed rather than reporting a machine with no network as up to date.
 */
async function installableVersion(): Promise<[number, number, number] | null> {
  try {
    const res = await fetch(CASK_RAW_URL, {
      headers: { 'User-Agent': 'geniro-app' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    // The cask is Ruby, and a full parse is neither available here nor needed:
    // one `version "x.y.z"` stanza is the whole of what this reads, and a cask
    // that no longer matches yields null — which degrades to the release feed
    // rather than to a wrong answer.
    const match = /^\s*version\s+"([^"]+)"/m.exec(await res.text());
    return match ? parseVersion(match[1]!) : null;
  } catch {
    // Swallowed deliberately: the cask is the SECOND opinion here, and a tap
    // that will not answer must cost the extra confidence, not the check.
    return null;
  }
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) {
    return {
      status: 'dev',
      version: app.getVersion(),
      message: 'update checks are disabled in dev',
    };
  }
  const current = parseVersion(app.getVersion());
  try {
    // Both asked at once — the cask read is the same round trip's worth of
    // waiting, and the answer needs both.
    const [res, cask] = await Promise.all([
      // GitHub's REST API requires a User-Agent; /releases/latest already
      // excludes drafts and pre-releases, so the newest stable tag wins.
      fetch(RELEASES_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'geniro-app',
        },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      }),
      installableVersion(),
    ]);
    if (!res.ok) {
      return {
        status: 'error',
        version: null,
        message: `release feed returned HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { tag_name?: unknown };
    const latest =
      typeof body.tag_name === 'string' ? parseVersion(body.tag_name) : null;
    if (!latest || !current) {
      return {
        status: 'error',
        version: null,
        message: 'could not read the latest release version',
      };
    }
    // What is ANNOUNCED is what can be installed. The cask is the authority
    // when it could be read; the release feed is the fallback for a tap that
    // did not answer, which is the old behaviour and its old risk — better
    // than going silent on a machine that simply cannot reach the tap.
    //
    // Note the deliberate consequence: for the ten or twenty minutes between a
    // release being published and its cask being bumped, this reports up to
    // date. That IS the honest answer — the version cannot be installed yet,
    // by brew or by the install script, so the only thing announcing it early
    // buys the user is a command that does nothing.
    const offered = cask ?? latest;
    if (isNewer(offered, current)) {
      const version = offered.join('.');
      return {
        status: 'available',
        version,
        message: `v${version} is available — update with: ${UPDATE_COMMAND} (or re-run the install script)`,
      };
    }
    return { status: 'up-to-date', version: app.getVersion(), message: null };
  } catch (err) {
    return {
      status: 'error',
      version: null,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Launch-time check, gated by the user's settings toggle. Fire-and-forget. */
export function checkOnLaunch(enabled: boolean): void {
  if (!enabled || !app.isPackaged) {
    return;
  }
  void checkForUpdates().then((result) => {
    if (result.status === 'error') {
      console.error('[ui] launch update check failed:', result.message);
    }
  });
}
