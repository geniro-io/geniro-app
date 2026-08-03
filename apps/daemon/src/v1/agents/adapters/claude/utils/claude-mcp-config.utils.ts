import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  type AgentTurnInput,
  GENIRO_MCP_SERVER_KEY,
} from '../../adapter.types';
import {
  CLAUDE_DISABLED_MCP_SERVERS_KEY,
  CLAUDE_MCP_CONFIG_FILE_MODE,
  CLAUDE_MCP_CONFIG_PREFIX,
  CLAUDE_MCP_CONFIG_SUFFIX,
  CLAUDE_PROJECT_MCP_FILE,
  CLAUDE_SETTINGS_PREFIX,
  CLAUDE_SETTINGS_SUFFIX,
} from '../claude.const';
import { parseProjectServerNames } from './claude-mcp-folder.utils';

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

/**
 * Write ONE turn's `--settings` file and return its path, or null when there is
 * nothing to say.
 *
 * `--settings` MERGES with the CLI's own configuration rather than replacing it
 * (probe-verified on 2.1.220 — see the evidence block in `claude.const.ts`), so
 * this file states only geniro's own overrides and leaves everything the user
 * configured intact.
 *
 * Per-turn rather than a long-lived file in userData: the disabled set is read
 * when the turn is built, so materializing it here means argv can never point
 * at a file that has since been rewritten by a toggle in another window.
 */
export function writeTurnSettings(
  dir: string,
  disabledServers: readonly string[],
): string | null {
  if (disabledServers.length === 0) {
    // No overrides means no flag at all — passing an empty settings file would
    // be one more thing that can be malformed for no gain.
    return null;
  }
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `${CLAUDE_SETTINGS_PREFIX}${randomUUID()}${CLAUDE_SETTINGS_SUFFIX}`,
  );
  writeFileSync(
    path,
    JSON.stringify({
      [CLAUDE_DISABLED_MCP_SERVERS_KEY]: [...disabledServers],
    }),
    { encoding: 'utf8', mode: CLAUDE_MCP_CONFIG_FILE_MODE },
  );
  return path;
}

/** The `--settings` twin of {@link sweepStaleTurnMcpConfigs}. */
export function sweepStaleTurnSettings(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      if (
        name.startsWith(CLAUDE_SETTINGS_PREFIX) &&
        name.endsWith(CLAUDE_SETTINGS_SUFFIX)
      ) {
        rmSync(join(dir, name), { force: true });
      }
    }
  } catch {
    // No dir yet, or an unreadable entry — nothing to sweep.
  }
}

/**
 * Whether the folder's own `.mcp.json` defines a server under geniro's key.
 *
 * A caller turn publishes its call surface under {@link GENIRO_MCP_SERVER_KEY},
 * and since `--strict-mcp-config` is no longer passed, the project's own
 * servers load alongside it. Probe-verified on 2.1.220: `--mcp-config` WINS
 * that collision, so the call surface is not hijacked — but the user's own
 * server of that name silently disappears from the turn, and the tool
 * namespace becomes ambiguous. The turn refuses instead.
 *
 * Read-only and synchronous: it runs inside `prepareTurn`, before the spawn.
 */
export function projectDefinesGeniroServer(cwd: string): boolean {
  let source: string;
  try {
    source = readFileSync(join(cwd, CLAUDE_PROJECT_MCP_FILE), 'utf8');
  } catch {
    return false;
  }
  return parseProjectServerNames(source).includes(GENIRO_MCP_SERVER_KEY);
}
