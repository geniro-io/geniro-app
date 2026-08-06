import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Daemon version — surfaced in `/health`, the pidfile, and the UI status line.
 *
 * Read from the daemon's own package.json rather than from an env var (the
 * sibling api reads `API_VERSION`, which a deployment sets) or a hardcoded
 * literal: this daemon ships INSIDE the app bundle, so there is no deployment
 * to inject anything, and `scripts/sync-app-version.mjs` stamps the release tag
 * into that package.json. A hardcoded constant silently kept reporting 0.1.0 on
 * tagged builds.
 *
 * The path resolves one level above `utils/` in every layout — source
 * (`apps/daemon`), built (`dist`), and the packaged `Resources/daemon`.
 */
export function readDaemonVersion(
  pkgPath: string = join(__dirname, '..', '..', 'package.json'),
): string {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version?: unknown;
    };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // Fall through to the safe default (an unreadable package.json shouldn't
    // crash the daemon; the version is informational).
  }
  return '0.0.0';
}

export const DAEMON_VERSION = readDaemonVersion();
