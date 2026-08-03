/**
 * Reading what claude's OWN config files say about a folder's MCP servers.
 *
 * Two questions the health listing cannot answer, because `claude mcp list`
 * prints no scope at all (probe-verified on 2.1.220):
 *
 * 1. which servers are project-scope — the only ones any verified mechanism
 *    can disable, and therefore the only ones that may carry a switch;
 * 2. which servers the user already disabled in their own settings — which
 *    geniro can never re-enable, because two `disabledMcpjsonServers` lists
 *    are UNIONed rather than overridden (probe-verified on 2.1.220).
 *
 * Every read here is read-only and best-effort: a missing file, a malformed
 * one, or an unreadable directory yields "nothing known" rather than an
 * error. These are the user's files; a feature that lists servers must not
 * fail because one of them has a stray comma.
 */

/** Names under `mcpServers` in a project config, or `[]` for anything else. */
export function parseProjectServerNames(source: string): string[] {
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
 * The `disabledMcpjsonServers` names in one settings file, or `[]`.
 *
 * Non-string entries are dropped rather than failing the whole read: this
 * list decides whether a row gets a switch, and one bad element must not
 * make every OTHER disabled server look toggleable.
 */
export function parseDisabledServerNames(source: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const disabled = (parsed as { disabledMcpjsonServers?: unknown })
    .disabledMcpjsonServers;
  if (!Array.isArray(disabled)) {
    return [];
  }
  return disabled.filter((entry): entry is string => typeof entry === 'string');
}
