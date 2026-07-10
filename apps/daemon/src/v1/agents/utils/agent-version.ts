import { type ChildProcess, execFile } from 'node:child_process';

import type { AgentKind } from '../../runs/runs.types';
import { resolveAgentBinary } from './agent-binary';
import { buildChildEnv } from './child-env';

export interface ResolveAgentVersionOptions {
  /** Kill a hung `--version` child after this long. */
  timeoutMs?: number;
  /** Replacement execFile for tests; defaults to node's. */
  execFileFn?: typeof execFile;
  /** Called with the spawned child so the caller can register it. */
  onSpawn?: (child: ChildProcess) => void;
}

const VERSION_TIMEOUT_MS = 5_000;

/**
 * `<binary> --version` as an opaque cache key (the cursor probe verdict is
 * cached per installed binary, re-probed only when the binary changes).
 * `null` means "version unknown" — callers must treat that as cache-miss,
 * never as "unsupported": a CLI that can't print a version can still work.
 * Never throws and never hangs (timeout kills the child).
 */
export function resolveAgentVersion(
  kind: AgentKind,
  options: ResolveAgentVersionOptions = {},
): Promise<string | null> {
  const run = options.execFileFn ?? execFile;
  return new Promise((resolve) => {
    const child = run(
      resolveAgentBinary(kind),
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
