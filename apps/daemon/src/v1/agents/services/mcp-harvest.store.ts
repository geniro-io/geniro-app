import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { environment } from '../../../environments';
import type { AgentKind } from '../../runs/runs.types';
import type {
  AgentMcpServer,
  AgentMcpServerStatus,
} from '../adapters/adapter.types';
import { harvestKey, HarvestStore } from './harvest-store';

/**
 * Defensive bound per key. A configured MCP set is a handful of servers; this
 * only exists so a malformed report cannot fill the disk.
 */
const MAX_HARVESTED = 200;

/**
 * How long a harvested reading may be served before the panel goes back to the
 * CLI.
 *
 * Unbounded, this store does not merely cache — it SHADOWS. The harvest is
 * consulted ahead of the live listing, so once any turn has run in a folder,
 * the lapsed-TTL re-dial below it is never reached again for as long as the
 * harvest lives. A server the user adds to `.mcp.json` would then never appear
 * until they ran another turn or pressed Reconnect, and the disk file makes
 * that survive restarts.
 *
 * Ten minutes: comfortably longer than the listing's own TTL, so the harvest
 * still absorbs the burst of panel opens that follows a turn — which is the
 * whole point of having one — while a folder nobody has run in for a while
 * settles back to being read from the CLI.
 */
const HARVEST_MAX_AGE_MS = 10 * 60 * 1000;

const STATUSES: ReadonlySet<string> = new Set<AgentMcpServerStatus>([
  'connected',
  'failed',
  'pending',
  'disabled',
  'unknown',
]);

/**
 * The MCP servers a CLI reported it had loaded, harvested from the
 * `mcp_servers` AgentEvent as turns run.
 *
 * This is what makes the panel answer instantly. Asking a CLI for its servers
 * with a one-shot subcommand is not a lookup — `claude mcp list` HEALTH-CHECKS,
 * dialling (and therefore starting) every configured server from cold, measured
 * at 6.7s here against nine servers, and bounded only by the slowest one. A
 * turn's own `system/init` names the same servers WITH their connection status
 * and costs nothing extra, because the turn was going to run anyway. That is
 * also why the CLI's own `/mcp` is instant while ours was not: it never
 * re-dials, it reads the session it already has.
 *
 * Keyed by `(agent, cwd, configDir)` — the same three dimensions
 * `AgentMcpService`'s own cache keys by, and for the same reason: a plugin
 * ships its own MCP servers, so two nodes on one CLI pointed at different
 * plugin directories genuinely load different sets, and one folder is
 * routinely used by both CLIs.
 *
 * Two things a harvest deliberately does NOT carry, both stated as null rather
 * than guessed (see {@link AgentMcpServer.target}):
 *
 * - **`target`/`transport`** — init reports a name and a status and nothing
 *   else, so the command line is unknown here. `AgentMcpService` fills it from
 *   a previous `mcp list` reading when it has one.
 * - **A settled status.** Init is a SNAPSHOT at turn start: a server still
 *   connecting reads `pending` and nothing later in that stream ever updates it
 *   (probe-verified on 2.1.222 — no MCP message follows init). `pending` here
 *   means "was still connecting when the turn began", which is true and useful,
 *   and the explicit Reconnect control is what settles it.
 */
@Injectable()
export class McpHarvestStore extends HarvestStore<AgentMcpServer> {
  constructor(options: { file?: string; now?: () => number } = {}) {
    super(
      options.file ?? join(environment.userDataDir, 'mcp-harvest.json'),
      MAX_HARVESTED,
      HARVEST_MAX_AGE_MS,
      options.now,
    );
  }

  protected isEntry(value: unknown): value is AgentMcpServer {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const row = value as Record<string, unknown>;
    const nullableString = (v: unknown): boolean =>
      v === null || typeof v === 'string';
    return (
      typeof row.name === 'string' &&
      typeof row.status === 'string' &&
      STATUSES.has(row.status) &&
      nullableString(row.target) &&
      nullableString(row.transport) &&
      nullableString(row.detail)
    );
  }

  /**
   * Record one turn's reported servers for the folder it ran in. De-duped by
   * name, first occurrence winning; an empty report is a no-op rather than an
   * eraser (see {@link HarvestStore.recordAt}).
   */
  record(
    agent: AgentKind,
    cwd: string,
    configDir: string | null,
    servers: AgentMcpServer[],
  ): void {
    const cleaned: AgentMcpServer[] = [];
    const seen = new Set<string>();
    for (const server of servers) {
      const name = server.name.trim();
      if (name === '' || seen.has(name)) {
        continue;
      }
      seen.add(name);
      cleaned.push({ ...server, name });
    }
    this.recordAt(harvestKey(agent, cwd, configDir ?? ''), cleaned);
  }

  /** The last set this agent reported here, or null when it never has. */
  get(
    agent: AgentKind,
    cwd: string,
    configDir: string | null,
  ): AgentMcpServer[] | null {
    return this.getAt(harvestKey(agent, cwd, configDir ?? ''));
  }
}
