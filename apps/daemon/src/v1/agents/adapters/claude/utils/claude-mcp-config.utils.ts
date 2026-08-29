import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { type AgentTurnInput } from '../../adapter.types';
import {
  CLAUDE_MCP_CONFIG_FILE_MODE,
  CLAUDE_MCP_CONFIG_PREFIX,
  CLAUDE_MCP_CONFIG_SUFFIX,
} from '../claude.const';

/**
 * Write ONE turn's `--mcp-config` file and return its path.
 *
 * The call token must never ride argv (`ps` shows it to every local account),
 * so it travels inside a 0600 file the turn's own user can read and argv
 * carries only the path. The name is random per turn, which is what lets
 * {@link sweepStaleTurnMcpConfigs} recognize the leftovers of a crashed launch
 * without knowing which turns existed.
 *
 * Published under the endpoint's OWN per-run name, the same value the ACP path
 * uses verbatim. It was a fixed shared key until the name was made to carry the
 * run, and the change is not cosmetic: `--strict-mcp-config` is not passed, so
 * the user's own servers load alongside this one, and an entry of theirs under
 * a shared key was silently dropped in favour of ours (probe-verified on
 * 2.1.220 — ours wins), costing them a server with no word said. A name
 * carrying the run id cannot be one a user has already chosen, so that
 * collision class stops existing rather than being guarded against.
 */
export function writeTurnMcpConfig(
  dir: string,
  endpoint: NonNullable<AgentTurnInput['mcpEndpoint']>,
): string {
  ensurePrivateDir(dir);
  const path = join(
    dir,
    `${CLAUDE_MCP_CONFIG_PREFIX}${randomUUID()}${CLAUDE_MCP_CONFIG_SUFFIX}`,
  );
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        [endpoint.serverName]: {
          type: 'http',
          url: endpoint.url,
          headers: { Authorization: `Bearer ${endpoint.token}` },
        },
      },
    }),
    { encoding: 'utf8', mode: CLAUDE_MCP_CONFIG_FILE_MODE },
  );
  return path;
}

/**
 * Delete any per-turn config files a prior daemon launch left in the config dir
 * (a crash/SIGKILL skips the per-turn disposer). Called once at boot — the
 * tokens inside are already dead (the registry is in-memory), so this is
 * hygiene, not a security fix. Best-effort: a missing dir or a busy file never
 * blocks boot.
 */
export function sweepStaleTurnMcpConfigs(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      if (
        name.startsWith(CLAUDE_MCP_CONFIG_PREFIX) &&
        name.endsWith(CLAUDE_MCP_CONFIG_SUFFIX)
      ) {
        rmSync(join(dir, name), { force: true });
      }
    }
  } catch {
    // No dir yet, or an unreadable entry — nothing to sweep.
  }
}

/**
 * Create the per-turn secret directory 0700, tightening one that already
 * exists.
 *
 * The files inside are 0600, so what a laxer directory leaks is the listing:
 * which turns are live and when each started. `mode` on `mkdirSync` applies
 * only to a directory this call CREATES, and the daemon's is
 * `<userData>/tmp` — long-lived, and 0755 on any install made before this
 * change. The `chmod` is what reaches those.
 */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Not ours to tighten (a shared parent, an odd filesystem). The files
    // themselves are still written 0600, which is the part that matters.
  }
}
