import { existsSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';

import { asRecord } from '../../../utils/json-util';
import type { AgentMcpOrigin } from '../../adapter.types';
import { CURSOR_PROJECT_ROOT_MARKER } from '../cursor-acp.const';

/**
 * Where cursor's servers come from.
 *
 * `cursor-agent mcp list` answers neither question. It merges
 * `~/.cursor/mcp.json` with the project's `.cursor/mcp.json` BY NAME and prints
 * one row per merged name, so a name defined at both scopes is reported once,
 * as the project's — and the row then describes a server the reader may never
 * have configured. Read out of the shipped bundle
 * (2026.08.11-e8db854, `9917.index.js`): the two files are merged, and a name
 * present in the PROJECT half is the one checked for approval.
 *
 * Everything here is best-effort by the same rule claude's folder read follows:
 * these are the user's own files, and a stray comma, a missing directory or an
 * unreadable one must degrade a label rather than fail the listing that carries
 * it. The parsers are pure; `cursorProjectRoot` touches the filesystem and is
 * here rather than on the adapter because it is how a path is turned into
 * another, not a decision the adapter makes.
 */

/**
 * The directory cursor treats as this folder's project root.
 *
 * The CLI's OWN walk, read from the bundle rather than guessed
 * (2026.08.11-e8db854): climb from the starting directory testing for a `.git`
 * entry, return the first that has one, and fall back to the starting
 * directory on reaching the filesystem root. `existsSync` and not a directory
 * check, deliberately — a linked worktree's `.git` is a FILE, and requiring a
 * directory would resolve every worktree to its main checkout and read the
 * wrong project's config.
 */
export function cursorProjectRoot(cwd: string): string {
  const { root } = parsePath(cwd);
  let at = cwd;
  for (;;) {
    if (existsSync(join(at, CURSOR_PROJECT_ROOT_MARKER))) {
      return at;
    }
    const up = dirname(at);
    if (up === at || up === root) {
      return cwd;
    }
    at = up;
  }
}

/** A user file's JSON object, or null for anything that is not one. */
export function parseJsonObject(
  source: string | null,
): Record<string, unknown> | null {
  if (source === null) {
    return null;
  }
  try {
    return asRecord(JSON.parse(source));
  } catch {
    return null;
  }
}

/** The `mcpServers` object of an `mcp.json`, or null for anything that is not that shape. */
export function parseMcpServers(
  source: string | null,
): Record<string, unknown> | null {
  return asRecord(parseJsonObject(source)?.mcpServers);
}

/**
 * Which scope each name resolves to, and which workspace definitions displaced
 * a user one on the way.
 *
 * The precedence is the CLI's own, not a choice made here: the project file is
 * merged OVER the user file, so a name in both is the workspace's. That is
 * exactly the case the label exists for — measured in a real folder defining
 * `codegraph` at both scopes, where the workspace copy was unapproved and the
 * working user copy was unreachable under that name.
 */
export function mcpOrigins(
  userNames: readonly string[],
  workspaceNames: readonly string[],
): Record<string, AgentMcpOrigin> {
  const user = new Set(userNames);
  const origins: Record<string, AgentMcpOrigin> = {};
  for (const name of userNames) {
    origins[name] = { scope: 'user', shadowsUser: false };
  }
  // Second, so a name in both ends up as the workspace's — the same order the
  // CLI merges in, and the reason this cannot be a single pass over a union.
  for (const name of workspaceNames) {
    origins[name] = { scope: 'workspace', shadowsUser: user.has(name) };
  }
  return origins;
}
