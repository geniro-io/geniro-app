/**
 * Whether a permission request names one of geniro's OWN tools on geniro's own
 * MCP server.
 *
 * A null `serverName` means this turn was GRANTED no such tool, and refuses
 * before any name is compared — the caller having decided not to register a
 * tool is the end of the question, whatever a request spells.
 *
 * Past that, ONE rule for both shipped CLIs, because both now see the server
 * under the same per-run name (`geniro-<runId8>`): claude spells its MCP tools
 * `mcp__<server>__<tool>` and cursor reports a permission request as one prose
 * label pairing the two, so requiring the name to contain BOTH halves matches
 * either shape without knowing which CLI sent it. The run id in the server name
 * is what makes it unforgeable — a user's own server cannot be named it — which
 * is the whole reason both halves are required rather than the tool name alone.
 */
export function isHostToolCall(
  serverName: string | null,
  toolName: string,
  hostToolName: string,
): boolean {
  if (serverName === null) {
    return false;
  }
  // claude's spelling is a fixed template, so it is matched EXACTLY.
  if (toolName === `mcp__${serverName}__${hostToolName}`) {
    return true;
  }
  // Anything else spelled `mcp__…` is another server's tool, whatever it
  // contains: without this a third-party server could carry the run-scoped name
  // inside its own tool name and be auto-approved on the containment rule below.
  if (toolName.startsWith('mcp__')) {
    return false;
  }
  // cursor's label has no fixed template — measured, it is the server name and
  // the tool name run together in prose — so containment is what is left, and
  // the run id inside the server name is what makes it safe.
  return toolName.includes(serverName) && toolName.includes(hostToolName);
}
