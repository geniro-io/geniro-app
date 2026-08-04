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
  /**
   * Ask the binary again instead of reusing a memoized answer.
   *
   * For the caller that already knows something changed — the MCP listing's
   * own `refresh=true`, where the user asked for a re-read precisely because
   * they believe the machine is no longer what geniro last saw.
   */
  forceRefresh?: boolean;
}

const VERSION_TIMEOUT_MS = 5_000;

/**
 * How long a resolved version is reused before the binary is asked again.
 *
 * Deliberately SHORT. The version is what every downstream cache is keyed by,
 * so a long memo would keep serving a stale key after the user upgrades their
 * CLI and the models / skills / MCP answers would stay pinned to the old
 * binary. A minute is long enough to collapse the burst this exists for — one
 * panel opening forks `--version` once per listing, and a chat switch, folder
 * change, Refresh, toggle write and debounced builder selection all land
 * inside it — and short enough that an upgrade is noticed while the user is
 * still wondering why.
 */
const VERSION_MEMO_TTL_MS = 60_000;

/** Resolved versions, keyed by the BINARY the version describes. */
const memo = new Map<string, { value: string | null; at: number }>();

/** Reads in flight, so N concurrent callers fork the CLI once between them. */
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Drop every memoized version. For specs only — nothing in the daemon calls
 * it, because a caller that genuinely needs a fresh reading asks for one
 * ({@link ResolveAgentVersionOptions.forceRefresh}) rather than clearing a
 * cache other callers are sharing.
 */
export function resetAgentVersionCache(): void {
  memo.clear();
  inFlight.clear();
}

/**
 * `<binary> --version` as an opaque cache key (a probe verdict is cached per
 * installed binary, re-probed only when the binary changes).
 * `null` means "version unknown" — callers must treat that as cache-miss,
 * never as "unsupported": a CLI that can't print a version can still work.
 * Never throws and never hangs (timeout kills the child).
 *
 * MEMOIZED per binary with a single-flight, because this is the one read that
 * happens BEFORE any consumer's own cache key can be computed — so every
 * consumer's cache HIT still paid for a process fork, and on a cache hit that
 * fork was the entire cost of the request. Both renderer hooks deliberately
 * hold no cache of their own ("the daemon already caches"), which is what made
 * the burst continuous rather than occasional.
 */
export function resolveAgentVersion(
  kind: AgentKind,
  options: ResolveAgentVersionOptions = {},
): Promise<string | null> {
  const binary = resolveAgentBinary(kind);
  if (!options.forceRefresh) {
    const hit = memo.get(binary);
    if (hit && Date.now() - hit.at < VERSION_MEMO_TTL_MS) {
      return Promise.resolve(hit.value);
    }
    const flight = inFlight.get(binary);
    if (flight) {
      return flight;
    }
  }
  const tracked: Promise<string | null> = spawnVersion(binary, options)
    .then((value) => {
      memo.set(binary, { value, at: Date.now() });
      return value;
    })
    .finally(() => {
      // Only if it is still OURS: a forced refresh may have replaced it.
      if (inFlight.get(binary) === tracked) {
        inFlight.delete(binary);
      }
    });
  inFlight.set(binary, tracked);
  return tracked;
}

/** The actual fork. Never throws; `null` is every failure. */
function spawnVersion(
  binary: string,
  options: ResolveAgentVersionOptions,
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
