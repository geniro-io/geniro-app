import { asArray, asRecord, asString } from '../../../utils/json-util';
import type { AgentMcpServer, AgentMcpServerStatus } from '../../adapter.types';
import { CODEX_MCP_SERVERS_KEY } from '../codex.const';

/**
 * The dotted config key for one MCP server's table — or, given a field, for
 * that field of it. A dotted key adds or edits one server without replacing
 * the whole `mcp_servers` table, so the user's own servers stay.
 */
export function codexMcpServerKey(server: string, field?: string): string {
  return [
    CODEX_MCP_SERVERS_KEY,
    server,
    ...(field === undefined ? [] : [field]),
  ].join('.');
}

/** `auth_status` → a row's status, for a server that is switched on. */
function statusFromAuth(authStatus: string | null): AgentMcpServerStatus {
  // The CLI spells these in snake_case (`not_logged_in`) and its protocol in
  // camelCase (`notLoggedIn`); compared with the separators removed.
  return authStatus?.replace(/_/g, '').toLowerCase() === 'notloggedin'
    ? 'needs_auth'
    : 'unknown';
}

/**
 * The servers `codex mcp list --json` names, or null when the output is not
 * that listing at all.
 *
 * This is codex's CONFIGURATION, not a health check: the command starts no
 * server, so a switched-on row is `unknown` unless its sign-in is known to be
 * missing. A transport's environment is deliberately never read — the listing
 * prints it verbatim, and it is where a server's secrets live.
 */
export function parseCodexMcpList(stdout: string): AgentMcpServer[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const servers: AgentMcpServer[] = [];
  for (const entry of asArray(parsed)) {
    const record = asRecord(entry);
    const name = record ? asString(record.name) : null;
    if (record === null || !name) {
      continue;
    }
    const transport = asRecord(record.transport);
    const type = asString(transport?.type);
    servers.push({
      name,
      target:
        type === 'stdio'
          ? asString(transport?.command)
          : asString(transport?.url),
      transport: type === 'stdio' ? 'stdio' : type === null ? null : 'http',
      status:
        record.enabled === false
          ? 'disabled'
          : statusFromAuth(asString(record.auth_status)),
      detail: asString(record.disabled_reason),
    });
  }
  return servers;
}
