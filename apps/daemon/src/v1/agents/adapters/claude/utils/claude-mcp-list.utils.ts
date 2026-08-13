import type {
  AgentMcpServer,
  AgentMcpServerHealth,
  AgentMcpServerStatus,
} from '../../adapter.types';
import {
  CLAUDE_MCP_CONNECTED_MARKER,
  CLAUDE_MCP_DETAIL_SEPARATOR,
  CLAUDE_MCP_FAILED_MARKER,
  CLAUDE_MCP_GET_STATUS_LABEL,
  CLAUDE_MCP_NEEDS_AUTH_MARKER,
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
  { marker: CLAUDE_MCP_NEEDS_AUTH_MARKER, status: 'needs_auth' },
];

/**
 * Split `<target> - <status …>` at the separator in front of the status.
 *
 * PRECONDITION: `rest` contains {@link TARGET_STATUS_SEPARATOR}. `parseMcpList`
 * is the only caller and skips any line without one — that check is what keeps
 * the CLI's prose out of the list, so it cannot be dropped — which is why the
 * fallback below indexes the separator unconditionally.
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
    // Unlike the fallback, this CAN miss: the separator is guaranteed
    // somewhere in `rest`, not before the marker. A row that opens with its
    // status has no target at all.
    const sep = before.lastIndexOf(TARGET_STATUS_SEPARATOR);
    return {
      target: (sep < 0 ? before : before.slice(0, sep)).trim(),
      statusText: rest.slice(at),
    };
  }
  const sep = rest.lastIndexOf(TARGET_STATUS_SEPARATOR);
  return {
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
 *   rejected earlier still, by the missing `<name>: ` delimiter.
 * - Empty/absent output yields `[]`. Note that `[]` alone does NOT mean the
 *   folder is empty — it also covers output this parser could not read — so
 *   the CALLER decides which, by checking for the CLI's own empty-folder
 *   sentence (`ClaudeAdapter.listMcpServers`).
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

/**
 * Read one server's health out of `claude mcp get <name>`.
 *
 * Lives beside `parseMcpList` rather than in a file of its own for one reason:
 * both read this CLI's prose about a server's health, and they MUST agree on the
 * marker→status mapping. Sharing {@link readStatus} is what makes that
 * structural instead of a convention two files try to keep.
 *
 * The output is a labelled block, and only the status line matters:
 *
 * ```
 * codegraph:
 *   Scope: User config (available in all your projects)
 *   Status: ✔ Connected
 *   Type: stdio
 * ```
 *
 * The glyph before the wording is stripped rather than matched — captured as
 * `✔` on a healthy server and `!` on `! Connected · tools fetch failed`
 * (2.1.228), and a decoration is exactly the kind of thing a release changes
 * without meaning anything by it.
 *
 * Null when no status line is there at all, which is also how a non-zero exit
 * arrives (`No MCP server named "x"`): the caller then leaves the row's health
 * unstated instead of calling a real server broken.
 *
 * Never throws.
 */
export function parseMcpGetHealth(
  stdout: string | null,
): AgentMcpServerHealth | null {
  if (!stdout) {
    return null;
  }
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith(CLAUDE_MCP_GET_STATUS_LABEL)) {
      continue;
    }
    const text = stripGlyph(line.slice(CLAUDE_MCP_GET_STATUS_LABEL.length));
    if (text.length === 0) {
      return null;
    }
    return readStatus(text);
  }
  return null;
}

/**
 * Drop a leading run of non-letter decoration, so the wording `readStatus`
 * matches on starts at its first word.
 *
 * Unicode-aware (`\p{L}`) because the glyphs seen here are not ASCII, and a
 * `[a-zA-Z]` scan would stop at the wrong place for a localized build.
 */
function stripGlyph(text: string): string {
  const at = text.search(/\p{L}/u);
  return at < 0 ? '' : text.slice(at).trim();
}
