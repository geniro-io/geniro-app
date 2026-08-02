import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type AgentTurnInput,
  GENIRO_MCP_SERVER_KEY,
} from '../../adapter.types';
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
 * The server is published under geniro's OWN key — the same
 * {@link GENIRO_MCP_SERVER_KEY} the cursor `.cursor/mcp.json` merge writes, so
 * the two CLIs can never end up naming different servers.
 */
export function writeTurnMcpConfig(
  dir: string,
  endpoint: NonNullable<AgentTurnInput['mcpEndpoint']>,
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `${CLAUDE_MCP_CONFIG_PREFIX}${randomUUID()}${CLAUDE_MCP_CONFIG_SUFFIX}`,
  );
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        [GENIRO_MCP_SERVER_KEY]: {
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
