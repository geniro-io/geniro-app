import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
  type Settings,
} from '@packages/types';

const execFileAsync = promisify(execFile);

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

function resolveBinary(kind: CliKind, override?: string): string | null {
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
    const candidate = join(normalized, kind);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function probeVersion(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(path, ['--version'], {
      timeout: 5000,
    });
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

/** Probe the host for each supported CLI agent (path + reported version). */
export async function detectClis(settings: Settings): Promise<CliDetection[]> {
  return Promise.all(
    CLI_KINDS.map(async (kind): Promise<CliDetection> => {
      const path = resolveBinary(kind, settings.cliPaths[kind]);
      if (!path) {
        return { kind, found: false, path: null, version: null };
      }
      const version = await probeVersion(path);
      return { kind, found: version !== null, path, version };
    }),
  );
}
