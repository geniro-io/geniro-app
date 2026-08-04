import { Injectable } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import { resolveAgentBinary } from '../utils/agent-binary';
import {
  type ResolveAgentVersionOptions,
  spawnAgentVersion,
} from '../utils/agent-version';

/**
 * How long a resolved version is reused before the binary is asked again.
 *
 * Deliberately SHORT. The version is what every downstream cache is keyed by,
 * so a long memo would keep serving a stale key after the user upgrades their
 * CLI, and the models / skills / MCP answers would stay pinned to the old
 * binary. A minute is long enough to collapse the burst this exists for — one
 * panel opening asks for a listing per CLI, and a chat switch, folder change,
 * Refresh, toggle write and debounced builder selection all land inside it —
 * and short enough that an upgrade is noticed while the user is still
 * wondering why.
 */
const VERSION_MEMO_TTL_MS = 60_000;

/** One binary's last answer, plus the flight that produced it. */
interface VersionEntry {
  value: string | null;
  /** The TTL clock. */
  at: number;
  /**
   * Which flight wrote it. SEPARATE from `at` because a timestamp cannot order
   * two forks started in the same millisecond — which is every pair under a
   * test clock, and a real pair whenever a Refresh lands while an ordinary
   * read is still out.
   */
  seq: number;
}

/**
 * `<binary> --version`, memoized per binary with a single-flight.
 *
 * A SERVICE rather than module state in `utils/`, which the module-structure
 * rule reserves for pure helpers with no DI: a process-global cache is shared
 * hidden state between four consumers, and testing it means reaching for a
 * reset hatch exported from production code. Per-instance state gives each
 * spec its own cache for free and matches how every other cache in this module
 * is held.
 *
 * It exists at all because this read happens BEFORE any consumer's own cache
 * key can be computed — the version is part of that key — so every consumer's
 * cache HIT still paid for a process fork, and on a hit that fork was the
 * entire cost of the request. Both renderer hooks deliberately hold no cache
 * of their own ("the daemon already caches"), which is what made the burst
 * continuous rather than occasional.
 */
@Injectable()
export class AgentVersionService {
  private readonly memo = new Map<string, VersionEntry>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private seq = 0;

  /**
   * The installed CLI's version string, or null when it cannot be read.
   *
   * `null` means "version unknown" — callers must treat that as a cache miss,
   * never as "unsupported": a CLI that cannot print a version can still work.
   * Never throws and never hangs.
   */
  resolve(
    kind: AgentKind,
    options: ResolveAgentVersionOptions = {},
  ): Promise<string | null> {
    const binary = resolveAgentBinary(kind);
    if (!options.forceRefresh) {
      const hit = this.memo.get(binary);
      if (hit && Date.now() - hit.at < VERSION_MEMO_TTL_MS) {
        return Promise.resolve(hit.value);
      }
      const flight = this.inFlight.get(binary);
      if (flight) {
        return flight;
      }
    }
    // Claimed when the fork STARTS, not when it answers. Two reads can be in
    // flight at once — a `forceRefresh` raised while an ordinary one is still
    // out — and whichever child exits last would otherwise win. The slower one
    // is the OLDER reading, so letting it land would re-pin the very answer
    // the refresh asked to replace, for the full TTL.
    const seq = ++this.seq;
    const at = Date.now();
    const tracked: Promise<string | null> = spawnAgentVersion(binary, options)
      .then((value) => {
        const current = this.memo.get(binary);
        if (!current || current.seq < seq) {
          this.memo.set(binary, { value, at, seq });
        }
        return value;
      })
      .finally(() => {
        // Only if it is still OURS: a forced refresh may have replaced it.
        if (this.inFlight.get(binary) === tracked) {
          this.inFlight.delete(binary);
        }
      });
    this.inFlight.set(binary, tracked);
    return tracked;
  }
}
