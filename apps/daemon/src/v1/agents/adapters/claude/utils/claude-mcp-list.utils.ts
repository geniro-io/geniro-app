import type { AgentMcpServer, AgentMcpServerStatus } from '../../adapter.types';
import {
  CLAUDE_MCP_CONNECTED_MARKER,
  CLAUDE_MCP_DETAIL_SEPARATOR,
  CLAUDE_MCP_EMPTY_MARKER,
  CLAUDE_MCP_FAILED_MARKER,
  CLAUDE_MCP_PENDING_MARKER,
} from '../claude.const';

/** The transport suffixes the CLI appends to a non-stdio target. */
const TRANSPORT_SUFFIXES: readonly {
  suffix: string;
  transport: AgentMcpServer['transport'];
}[] = [
  { suffix: ' (HTTP)', transport: 'http' },
  { suffix: ' (SSE)', transport: 'sse' },
];

const STATUS_MARKERS: readonly {
  marker: string;
  status: AgentMcpServerStatus;
}[] = [
  { marker: CLAUDE_MCP_CONNECTED_MARKER, status: 'connected' },
  { marker: CLAUDE_MCP_FAILED_MARKER, status: 'failed' },
  { marker: CLAUDE_MCP_PENDING_MARKER, status: 'pending' },
];

/** Split `<target> - <status …>` at the LAST separator before the status. */
function splitAtStatus(rest: string): { target: string; statusText: string } {
  for (const { marker } of STATUS_MARKERS) {
    const at = rest.indexOf(marker);
    if (at < 0) {
      continue;
    }
    // Anchor on the marker, then walk back to the separator in front of it. A
    // naive split on ' - ' would cut the row in the wrong place whenever the
    // server's own command carries one as an argument.
    const before = rest.slice(0, at);
    const sep = before.lastIndexOf(' - ');
    return {
      target: (sep < 0 ? before : before.slice(0, sep)).trim(),
      statusText: rest.slice(at),
    };
  }
  return { target: rest.trim(), statusText: '' };
}

/** Peel ` (HTTP)` / ` (SSE)` off the target; anything else is stdio. */
function splitTransport(target: string): {
  target: string;
  transport: AgentMcpServer['transport'];
} {
  for (const { suffix, transport } of TRANSPORT_SUFFIXES) {
    if (target.endsWith(suffix)) {
      return { target: target.slice(0, -suffix.length).trim(), transport };
    }
  }
  return { target, transport: 'stdio' };
}

/** The status plus whatever the CLI printed after it, or null. */
function readStatus(statusText: string): {
  status: AgentMcpServerStatus;
  detail: string | null;
} {
  for (const { marker, status } of STATUS_MARKERS) {
    if (!statusText.startsWith(marker)) {
      continue;
    }
    const tail = statusText.slice(marker.length).trim();
    const detail = tail.startsWith(CLAUDE_MCP_DETAIL_SEPARATOR)
      ? tail.slice(CLAUDE_MCP_DETAIL_SEPARATOR.length).trim()
      : tail;
    return { status, detail: detail.length > 0 ? detail : null };
  }
  return { status: 'unknown', detail: null };
}

/**
 * Parse `claude mcp list` stdout into the servers it reported.
 *
 * The CLI has no machine-readable mode for this (`--json` is rejected), so
 * this reads its prose — which makes the parser version-volatile by
 * construction. Every degradation is therefore deliberate and non-fatal:
 *
 * - A row whose status wording is not recognised still yields a server, with
 *   `status: 'unknown'`. A CLI that renames "Connected" must cost the user a
 *   health badge, never the server itself.
 * - A line with no `<name>: ` at all is dropped — there is nothing to name.
 * - The `No MCP servers configured` sentence yields `[]`, not a bogus row, and
 *   so does empty/absent output (the caller's spawn-failure signal).
 *
 * Never throws.
 */
export function parseMcpList(stdout: string | null): AgentMcpServer[] {
  if (!stdout) {
    return [];
  }
  const servers: AgentMcpServer[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(CLAUDE_MCP_EMPTY_MARKER)) {
      continue;
    }
    // The name is everything before the first `': '`. A URL's `https://` has no
    // space after the colon, so it cannot be mistaken for the delimiter — and
    // this also skips the `Checking MCP server health…` header, which has none.
    const delimiter = line.indexOf(': ');
    if (delimiter <= 0) {
      continue;
    }
    const name = line.slice(0, delimiter).trim();
    if (name.length === 0) {
      continue;
    }
    const { target: rawTarget, statusText } = splitAtStatus(
      line.slice(delimiter + 2),
    );
    const { target, transport } = splitTransport(rawTarget);
    const { status, detail } = readStatus(statusText);
    servers.push({ name, target, transport, status, detail });
  }
  return servers;
}
