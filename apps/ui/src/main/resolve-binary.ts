import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Directories to search in addition to `$PATH`. A GUI-launched macOS app
 * inherits a stripped `$PATH` (no `~/.local/bin`, no Homebrew), so we probe the
 * common install locations explicitly (cf. Omnigent server_manager.js PATH
 * resolution).
 */
const WELL_KNOWN_DIRS = [
  join(homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(homedir(), '.bun', 'bin'),
  join(homedir(), '.npm-global', 'bin'),
];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path of a user-installed CLI, or null when it is not on this machine.
 *
 * Every spawn of a user's own CLI goes through this rather than handing
 * `execFile` a bare name. Under launchd — which is how a packaged app is
 * launched from Finder or the Dock — `$PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`,
 * so `git` resolves and everything installed by Homebrew, npm or bun does not:
 * a bare-name spawn works in development, where the app inherits a terminal's
 * environment, and fails in the shipped build.
 */
export function resolveBinary(name: string, override?: string): string | null {
  if (override && isExecutable(override)) {
    return override;
  }
  const seen = new Set<string>();
  const dirs = [...(process.env.PATH?.split(':') ?? []), ...WELL_KNOWN_DIRS];
  for (const dir of dirs) {
    // Skip empty and relative $PATH entries — a resolved binary path must be
    // absolute (M2 hands it to the daemon to spawn agents with a project cwd).
    if (!dir || !isAbsolute(dir)) {
      continue;
    }
    const normalized = resolve(dir);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const candidate = join(normalized, name);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}
