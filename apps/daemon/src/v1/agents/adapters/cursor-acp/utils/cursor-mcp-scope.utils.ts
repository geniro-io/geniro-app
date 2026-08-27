import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, parse as parsePath } from 'node:path';

import type { AgentMcpOrigin } from '../../adapter.types';
import { CURSOR_PROJECT_ROOT_MARKER } from '../cursor-acp.const';

/**
 * Where cursor's servers come from, and what its own app loads that a headless
 * turn does not.
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
 * it. The parsers are pure; the three readers below touch the filesystem and
 * are here rather than on the adapter because none of them is a decision the
 * adapter makes — they are how a path is turned into text.
 */

/**
 * Every directory under `root`, down to `depth` levels, `root` excluded.
 *
 * Bounded rather than exhaustive on purpose — the caller walks a plugin CACHE,
 * which holds a whole source checkout per plugin, and this runs inside a read
 * the panel is waiting on.
 */
export async function descendants(
  root: string,
  depth: number,
): Promise<string[]> {
  if (depth <= 0) {
    return [];
  }
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
  const deeper = await Promise.all(
    entries.map((entry) => descendants(entry, depth - 1)),
  );
  return [...entries, ...deeper.flat()];
}

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

/** Names under `mcpServers`, or `[]` for anything that is not that shape. */
export function parseMcpServerNames(source: string | null): string[] {
  if (source === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (
    typeof servers !== 'object' ||
    servers === null ||
    Array.isArray(servers)
  ) {
    return [];
  }
  return Object.keys(servers);
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

/**
 * The MCP servers one plugin manifest declares, or `[]`.
 *
 * A plugin points at its own config file (`"mcpServers": "./.dd_cursor_mcp.json"`
 * in datadog's manifest), so the NAMES are in that second file — which is why
 * this takes the already-read contents rather than a path.
 */
export function parsePluginMcpPath(manifest: string | null): string | null {
  if (manifest === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const path = (parsed as { mcpServers?: unknown }).mcpServers;
  return typeof path === 'string' && path.length > 0 ? path : null;
}

/**
 * The sentence naming what cursor's own app loads and a geniro turn does not,
 * or null when the machine has no such plugin.
 *
 * MEASURED three ways before it was written, because the claim it makes is that
 * a server the user can SEE working in Cursor is absent here — 2026.08.11-e8db854,
 * with `datadog` installed as a plugin: `mcp list` never reports it, `mcp
 * list-tools datadog` answers `MCP client "datadog" not found in config` (and
 * that code path consults the plugin service before giving up), and a live
 * `cursor-agent -p` turn asked to enumerate its own tools returned 110 of them
 * with none from datadog.
 *
 * It NAMES them rather than listing them as rows for the reason the claude note
 * beside it does: a row promises the agent tools it will not have.
 */
export function pluginOnlyNote(names: readonly string[]): string | null {
  const unique = [...new Set(names)].sort();
  if (unique.length === 0) {
    return null;
  }
  return `cursor also loads ${unique.join(', ')} from its own plugins. Plugin servers reach cursor's app, not the headless turns geniro runs, so they are not listed here.`;
}
