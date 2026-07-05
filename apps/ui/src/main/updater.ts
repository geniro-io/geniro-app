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
    // GitHub's REST API requires a User-Agent; /releases/latest already
    // excludes drafts and pre-releases, so the newest stable tag wins.
    const res = await fetch(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'geniro-app',
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
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
    if (isNewer(latest, current)) {
      const version = latest.join('.');
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
