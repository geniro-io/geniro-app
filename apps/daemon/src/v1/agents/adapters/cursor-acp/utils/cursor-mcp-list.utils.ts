import type { AgentMcpServer, AgentMcpServerStatus } from '../../adapter.types';
import {
  CURSOR_MCP_FAILED_MARKER,
  CURSOR_MCP_PENDING_MARKER,
  CURSOR_MCP_READY_MARKER,
} from '../cursor-acp.const';

/** Separates a row's name from its status: `<name>: <status>`. */
const NAME_STATUS_SEPARATOR = ': ';

const STATUS_MARKERS: readonly {
  marker: string;
  status: AgentMcpServerStatus;
}[] = [
  { marker: CURSOR_MCP_READY_MARKER, status: 'connected' },
  { marker: CURSOR_MCP_FAILED_MARKER, status: 'failed' },
  { marker: CURSOR_MCP_PENDING_MARKER, status: 'pending' },
];

/**
 * The status a piece of text opens with, plus whatever followed it.
 *
 * Requires a word boundary after the marker, so a future `readyish` is not read
 * as `ready` with a stray detail.
 */
function readStatus(
  text: string,
): { status: AgentMcpServerStatus; detail: string | null } | null {
  for (const { marker, status } of STATUS_MARKERS) {
    if (!text.startsWith(marker)) {
      continue;
    }
    if (text.length !== marker.length && text[marker.length] !== ' ') {
      continue;
    }
    const detail = text.slice(marker.length).trim();
    return { status, detail: detail.length > 0 ? detail : null };
  }
  return null;
}

/**
 * Parse `cursor-agent mcp list` stdout into the servers it reported.
 *
 * A row is `<name>: <status>` and carries nothing else — no command, no URL, no
 * transport (probe-verified on 2026.07.23-e383d2b), which is why every server
 * this returns has a null `target` and a null `transport`.
 *
 * **Why the split walks in from the RIGHT.** Both halves of a row may contain
 * the delimiter. A server may be named `weird: name`, which the CLI prints as
 * `weird: name: not loaded (needs approval)`; and every failure reads
 * `Error: Connection failed`, which carries one of its own. Splitting on the
 * first `': '` mis-parses the former, splitting on the last mis-parses the
 * latter. So this scans the separators from the right and takes the first one
 * whose remainder is a status the CLI is known to print — the name is then
 * everything before it, however many colons it contains.
 *
 * **Why an unrecognised status drops the row, unlike claude's parser.** A
 * claude row has a structural `' - '` between target and status, so a row can
 * be recognised as a row without understanding its status wording — which lets
 * that parser keep the server and degrade the badge to `unknown`. A cursor row
 * has no such marker: `Note: a new version is available` is shaped exactly like
 * a server row. Here the status vocabulary IS the only row test, so a forgiving
 * fallback would promote the CLI's own prose into the one surface whose job is
 * to say what the user configured. Dropping instead is not silent: the caller
 * sees zero rows without the empty-folder sentence and reports the listing as
 * unreadable, so a reworded release surfaces as a visible "the output format
 * may have changed" rather than as a confident "you have no servers".
 *
 * Empty/absent output yields `[]`. As with claude, `[]` alone does NOT mean the
 * folder is empty — the CALLER decides that by looking for the CLI's own
 * empty-folder sentence.
 *
 * Never throws.
 */
export function parseCursorMcpList(stdout: string | null): AgentMcpServer[] {
  if (!stdout) {
    return [];
  }
  const servers: AgentMcpServer[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    let at = line.lastIndexOf(NAME_STATUS_SEPARATOR);
    while (at > 0) {
      const read = readStatus(line.slice(at + NAME_STATUS_SEPARATOR.length));
      if (read !== null) {
        servers.push({
          name: line.slice(0, at).trim(),
          // Both null on every row, not just some: this CLI reports neither for
          // any server, so a row that claimed either would be inventing it.
          target: null,
          transport: null,
          status: read.status,
          detail: read.detail,
        });
        break;
      }
      at = line.lastIndexOf(NAME_STATUS_SEPARATOR, at - 1);
    }
  }
  return servers;
}
