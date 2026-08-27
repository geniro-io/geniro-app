import { Injectable } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { ConfigDirPin } from '../adapters/adapter.types';
import { AgentAdapterRegistry } from './agent-adapter.registry';

/**
 * How long one folder's answer is reused. The pin lives in a file the USER
 * edits, so it must not be cached for the life of the process — but a run list
 * projects every row at once and the sidebar refetches on every settle, so
 * without any memo one glance at a folder holding a dozen chats is a dozen
 * identical reads.
 *
 * Seconds rather than minutes: this is a latency shield for one burst of
 * projections, not a cache of a fact. An edit made in the editor shows up on
 * the next list the sidebar asks for.
 */
const PIN_TTL_MS = 5_000;

/**
 * Which config directory a folder PINS for a given CLI, asked of that CLI's
 * own adapter and memoized per (agent, folder).
 *
 * Its own service rather than a method on `ChatService` for the reason the
 * daemon's module rules give: this is business logic with a cache and a
 * lifetime, and `ChatService` is already the largest thing in the module. It
 * COMPOSES only — which files are read, and whether the CLI has such a
 * mechanism at all, are the adapter's business (`AgentAdapter.readConfigDirPin`),
 * so nothing here names a CLI.
 */
@Injectable()
export class ConfigDirPinService {
  private readonly cache = new Map<
    string,
    { at: number; pin: ConfigDirPin | null }
  >();

  constructor(private readonly adapters: AgentAdapterRegistry) {}

  /**
   * The pin in force for this run, or null when there is none.
   *
   * A run with no agent or no folder has nothing to ask about: a workflow run's
   * agents are per node, and there is no folder whose settings could pin
   * anything. Both answer null rather than being treated as an error, because a
   * run projection cannot fail over a readout.
   */
  forRun(agentKind: AgentKind | null, cwd: string | null): ConfigDirPin | null {
    if (agentKind === null || cwd === null) {
      return null;
    }
    // A NUL separator, written as its ESCAPE: the raw byte and `\u0000` are
    // the identical code unit at runtime, and the raw one makes git classify
    // this source as binary - no diff, no review comments, no three-way
    // merge. NUL rather than a space because a folder path may contain one.
    const key = `${agentKind}\u0000${cwd}`;
    const cached = this.cache.get(key);
    const now = Date.now();
    if (cached && now - cached.at < PIN_TTL_MS) {
      return cached.pin;
    }
    const pin = this.adapters.for(agentKind).readConfigDirPin(cwd);
    this.cache.set(key, { at: now, pin });
    return pin;
  }

  /** Forget every memoized answer — the caches-clear route's share of this. */
  clear(): void {
    this.cache.clear();
  }
}
