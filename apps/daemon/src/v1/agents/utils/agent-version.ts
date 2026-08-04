import { type ChildProcess, execFile } from 'node:child_process';

import { buildChildEnv } from './child-env';

export interface ResolveAgentVersionOptions {
  /** Kill a hung `--version` child after this long. */
  timeoutMs?: number;
  /** Replacement execFile for tests; defaults to node's. */
  execFileFn?: typeof execFile;
  /** Called with the spawned child so the caller can register it. */
  onSpawn?: (child: ChildProcess) => void;
  /**
   * Ask the binary again instead of reusing a memoized answer.
   *
   * Read by {@link AgentVersionService}, not here — this function always forks.
   * It rides the same options bag so a caller states its intent once, at the
   * call site that has the reason: the MCP listing's own `refresh=true`, where
   * the user asked for a re-read precisely because they believe the machine is
   * no longer what geniro last saw.
   */
  forceRefresh?: boolean;
}

const VERSION_TIMEOUT_MS = 5_000;

/**
 * Fork `<binary> --version` and return its first non-empty line.
 *
 * Pure in the sense `utils/` means: no state, no DI, one child per call. The
 * memo and single-flight that stop this being forked on every request live in
 * `services/agent-version.service.ts`, because a cache is state and state in a
 * util is state shared by every consumer with no way to scope it.
 *
 * Never throws and never hangs — the timeout kills the child, and every
 * failure (missing binary, non-zero exit, deadline) answers `null`.
 */
export function spawnAgentVersion(
  binary: string,
  options: ResolveAgentVersionOptions = {},
): Promise<string | null> {
  const run = options.execFileFn ?? execFile;
  return new Promise((resolve) => {
    const child = run(
      binary,
      ['--version'],
      {
        timeout: options.timeoutMs ?? VERSION_TIMEOUT_MS,
        encoding: 'utf8',
        env: buildChildEnv(),
      },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        // First non-empty line only — some CLIs print update banners after it.
        const line = String(stdout)
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.length > 0);
        resolve(line ?? null);
      },
    );
    options.onSpawn?.(child);
  });
}
