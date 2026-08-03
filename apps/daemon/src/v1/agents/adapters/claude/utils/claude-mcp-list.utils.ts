import type { AgentMcpServer, AgentMcpServerStatus } from '../../adapter.types';
import {
  CLAUDE_MCP_CONNECTED_MARKER,
  CLAUDE_MCP_DETAIL_SEPARATOR,
  CLAUDE_MCP_FAILED_MARKER,
  CLAUDE_MCP_PENDING_MARKER,
} from '../claude.const';

/** Separates a row's target from its status: `<name>: <target> - <status>`. */
const TARGET_STATUS_SEPARATOR = ' - ';

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

/**
 * Split `<target> - <status …>` at the separator in front of the status.
 *
 * Anchors on the status marker and walks BACK to the separator, because a
 * server's own command may carry ` - ` as an argument and a naive split would
 * then cut the row in the wrong place. When no marker is recognised — the
 * version-drift case — it falls back to the last separator, so the target
 * stays the target and the unrecognised wording becomes the detail rather than
 * being glued onto the command.
 */
function splitAtStatus(rest: string): { target: string; statusText: string } {
  for (const { marker } of STATUS_MARKERS) {
    const at = rest.indexOf(marker);
    if (at < 0) {
      continue;
    }
    const before = rest.slice(0, at);
    const sep = before.lastIndexOf(TARGET_STATUS_SEPARATOR);
    return {
      target: (sep < 0 ? before : before.slice(0, sep)).trim(),
      statusText: rest.slice(at),
    };
  }
  const sep = rest.lastIndexOf(TARGET_STATUS_SEPARATOR);
  return sep < 0
    ? { target: rest.trim(), statusText: '' }
    : {
        target: rest.slice(0, sep).trim(),
        statusText: rest.slice(sep + TARGET_STATUS_SEPARATOR.length).trim(),
      };
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
  // Unrecognised wording is still shown to the user — it is the CLI's own
  // description of a real server's health, and hiding it would leave the row
  // saying nothing at all.
  return {
    status: 'unknown',
    detail: statusText.length > 0 ? statusText : null,
  };
}

/**
 * Parse `claude mcp list` stdout into the servers it reported.
 *
 * The CLI has no machine-readable mode for this (`--json` is rejected), so
 * this reads its prose — which makes the parser version-volatile by
 * construction. Every degradation is therefore deliberate and non-fatal:
 *
 * - A row whose status wording is not recognised still yields a server, with
 *   `status: 'unknown'` and the wording kept as its detail. A CLI that renames
 *   "Connected" must cost the user a health badge, never the server itself.
 * - A line that is not shaped like a row — no `<name>: `, or no ` - ` before a
 *   status — is dropped. That shape check is what keeps the CLI's own prose out
 *   of the list: claude prints update banners on stdout (`agent-version.ts`
 *   works around the same thing), and `Note: a new version is available` would
 *   otherwise be listed as a server named "Note" in the one surface whose job
 *   is to say what the user has configured. The empty-folder sentence is
 *   rejected by the same check.
 * - Empty/absent output yields `[]`.
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
    // The name is everything before the first `': '`. A URL's `https://` has no
    // space after the colon, so it cannot be mistaken for the delimiter — and
    // this also skips the `Checking MCP server health…` header, which has none.
    const delimiter = line.indexOf(': ');
    if (delimiter <= 0) {
      continue;
    }
    const rest = line.slice(delimiter + 2);
    // A row always separates its target from its status. Prose does not, which
    // is what keeps a banner line from being listed as a server.
    if (!rest.includes(TARGET_STATUS_SEPARATOR)) {
      continue;
    }
    const name = line.slice(0, delimiter).trim();
    const { target: rawTarget, statusText } = splitAtStatus(rest);
    const { target, transport } = splitTransport(rawTarget);
    const { status, detail } = readStatus(statusText);
    servers.push({ name, target, transport, status, detail });
  }
  return servers;
}
