import type { AgentMcpServer, AgentMcpServerStatus } from '../../adapter.types';
import {
  CURSOR_MCP_DISABLED_MARKER,
  CURSOR_MCP_FAILED_MARKER,
  CURSOR_MCP_LOADING_MARKER,
  CURSOR_MCP_NEEDS_AUTH_MARKER,
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
  { marker: CURSOR_MCP_LOADING_MARKER, status: 'loading' },
  { marker: CURSOR_MCP_DISABLED_MARKER, status: 'disabled' },
  { marker: CURSOR_MCP_NEEDS_AUTH_MARKER, status: 'needs_auth' },
];

/**
 * The status a piece of text opens with, plus whatever followed it, or null
 * when the wording is not one this CLI is known to print.
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
 * Split one line into its name and its status, or null when the line is not
 * shaped like a row at all.
 *
 * **Why the search walks in from the RIGHT.** Both halves of a row may contain
 * the delimiter. A server may be named `weird: name`, which the CLI prints as
 * `weird: name: not loaded (needs approval)`; and every failure reads
 * `Error: Connection failed`, which carries one of its own. Splitting on the
 * first `': '` mis-parses the former, splitting on the last mis-parses the
 * latter. So this scans the separators from the right and takes the first one
 * whose remainder is a status the CLI is known to print — the name is then
 * everything before it, however many colons it contains.
 *
 * When NO separator yields a known status, the line still counts as a row and
 * splits at the FIRST separator, with the remainder kept as an unreadable
 * status. See `parseCursorMcpList` for why that is the safer degradation.
 */
function splitRow(line: string): {
  name: string;
  status: AgentMcpServerStatus;
  detail: string | null;
} | null {
  let at = line.lastIndexOf(NAME_STATUS_SEPARATOR);
  while (at > 0) {
    // trimStart because the status is matched against a closed vocabulary: a
    // release that column-aligns its output (`srv:  ready`) would otherwise
    // match nothing at all.
    const read = readStatus(
      line.slice(at + NAME_STATUS_SEPARATOR.length).trimStart(),
    );
    if (read !== null) {
      return { name: line.slice(0, at).trim(), ...read };
    }
    at = line.lastIndexOf(NAME_STATUS_SEPARATOR, at - 1);
  }
  const first = line.indexOf(NAME_STATUS_SEPARATOR);
  if (first <= 0) {
    return null;
  }
  const rest = line.slice(first + NAME_STATUS_SEPARATOR.length).trim();
  return {
    name: line.slice(0, first).trim(),
    status: 'unknown',
    detail: rest.length > 0 ? rest : null,
  };
}

/**
 * Parse `cursor-agent mcp list` stdout into the servers it reported.
 *
 * A row is `<name>: <status>` and carries nothing else — no command, no URL, no
 * transport (probe-verified on 2026.07.23-e383d2b), which is why every server
 * this returns has a null `target` and a null `transport`.
 *
 * **An unrecognised status costs the badge, never the row** — the same rule
 * `parseMcpList` follows for claude, and the one {@link AgentMcpServerStatus}
 * states. It is worth spelling out why, because cursor makes it a genuinely
 * closer call: a claude row has a structural `' - '` that identifies it as a
 * row without understanding its status, while a cursor row has no marker at
 * all, so keeping unreadable rows means a line of CLI prose shaped like
 * `Note: a new version is available` is listed as a server named "Note".
 *
 * That is the lesser harm, and the choice is not hypothetical. Dropping such
 * rows instead was tried first and is WRONG in a way testing caught: only a
 * listing where EVERY row drops is detectable by the caller, so a partly
 * unfamiliar listing returns the rows it did understand and silently denies the
 * rest — the panel stating, as fact, that a folder has one server when the CLI
 * named two, cached for the whole TTL. `cursor-agent mcp disable` reaches that
 * state on a shipped binary today. A bogus "Note" row is visible and mildly
 * confusing; a missing server is invisible and wrong, and this surface exists
 * to say what the user configured.
 *
 * Empty/absent output yields `[]`. As with claude, `[]` alone does NOT mean the
 * folder is empty — the CALLER decides that by looking for the CLI's own
 * empty-folder sentence, which is safely excluded here because it carries no
 * `': '` of its own.
 *
 * Never throws.
 */
export function parseCursorMcpList(stdout: string | null): AgentMcpServer[] {
  if (!stdout) {
    return [];
  }
  const servers: AgentMcpServer[] = [];
  for (const rawLine of stdout.split('\n')) {
    // Also strips the `\r` of a CRLF stream; without it every row would carry a
    // trailing carriage return into the status match and fail it.
    const row = splitRow(rawLine.trim());
    if (row === null) {
      continue;
    }
    servers.push({
      name: row.name,
      // Both null on every row, not just some: this CLI reports neither for
      // any server, so a row that claimed either would be inventing it.
      target: null,
      transport: null,
      status: row.status,
      detail: row.detail,
    });
  }
  return servers;
}
