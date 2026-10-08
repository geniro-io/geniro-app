import {
  CLAUDE_DISALLOWED_TOOLS_FLAG,
  CLAUDE_MCP_TOOL_PREFIX,
} from '../claude.const';

/**
 * The server segment claude puts in an MCP tool's name, for a server as it is
 * NAMED in config and in `claude mcp list`.
 *
 * Transcribed from the CLI's own normalizer (`bn` in the 2.1.284 bundle —
 * `strings` of `~/.local/share/claude/versions/2.1.284`, beside the
 * `claude.ai ` / `claude_ai_` constants): every character outside
 * `[a-zA-Z0-9_-]` becomes `_`, and a name starting `claude.ai ` (an account
 * connector) additionally has its underscore runs collapsed and its ends
 * trimmed. So `claude.ai Booking.com` → `claude_ai_Booking_com` and
 * `plugin:playwright:playwright` → `plugin_playwright_playwright`, which is
 * what the tool names in `system/init` read.
 */
export function claudeMcpServerSegment(server: string): string {
  const replaced = server.replace(/[^a-zA-Z0-9_-]/g, '_');
  return server.startsWith('claude.ai ')
    ? replaced.replace(/_+/g, '_').replace(/^_|_$/g, '')
    : replaced;
}

/**
 * The `--disallowedTools` rule that takes EVERY tool of one server away.
 *
 * The CLI reads a rule by splitting it on `__` (`Is` in the 2.1.284 bundle):
 * `mcp__<server>` with no tool part is a server-level rule, matched against
 * each tool's own server segment (`jHe` → `isServerLevelDisallowed`). A
 * segment that itself contains `__` would split wrongly — `mcp__a__b` reads as
 * tool `b` of server `a` — so such a server is named with a tool wildcard
 * instead (`mcp__a__b__*` → server `a`, tool pattern `b__*`), which covers
 * exactly that server's tools.
 */
export function claudeMcpServerRule(server: string): string {
  const segment = claudeMcpServerSegment(server);
  return segment.includes('__')
    ? `${CLAUDE_MCP_TOOL_PREFIX}${segment}__*`
    : `${CLAUDE_MCP_TOOL_PREFIX}${segment}`;
}

/**
 * The argv that withholds a workflow node's switched-off MCP servers from one
 * claude process — nothing when none are switched off.
 *
 * MEASURED on 2.1.284 (`claude -p --output-format stream-json --verbose`, read
 * to `system/init`, in a folder loading codegraph and the playwright plugin):
 * 125 tools with no flag; `--disallowedTools mcp__codegraph
 * mcp__plugin_playwright_playwright` → 96, every `mcp__codegraph__*` and
 * `mcp__plugin_playwright_playwright__*` gone, both servers still listed
 * `connected`. The CLI still DIALS a disallowed server; the model is never
 * offered its tools, which is the switch the node asked for.
 *
 * geniro's OWN server (`ownServer`, the per-run endpoint) is never withheld,
 * whatever the node lists: a node switching it off would lose its call surface
 * while its instructions still told it to use it. Duplicates are dropped.
 */
export function claudeDisallowedMcpArgs(
  servers: readonly string[] | undefined,
  ownServer: string | null,
): string[] {
  const own = ownServer === null ? null : claudeMcpServerSegment(ownServer);
  const rules = [
    ...new Set(
      (servers ?? [])
        .filter((server) => server.length > 0)
        .filter((server) => claudeMcpServerSegment(server) !== own)
        .map(claudeMcpServerRule),
    ),
  ];
  return rules.length === 0 ? [] : [CLAUDE_DISALLOWED_TOOLS_FLAG, ...rules];
}
