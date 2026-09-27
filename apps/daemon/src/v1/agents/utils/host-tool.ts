/**
 * Whether a permission request names one of geniro's OWN tools on geniro's own
 * MCP server.
 *
 * A null `serverName` means this turn was GRANTED no such tool, and refuses
 * before any name is compared — the caller having decided not to register a
 * tool is the end of the question, whatever a request spells.
 *
 * Past that, the name must be EXACTLY one of the two spellings the shipped
 * CLIs are measured to send. Both see the server under the same per-run name
 * (`geniro-<runId8>`), and the run id in it is what a user's own server cannot
 * be named:
 *
 * - claude names an MCP tool `mcp__<server>__<tool>`, a fixed template.
 * - cursor's ACP permission request carries no tool NAME, only a TITLE, which
 *   the driver reads in its place. An MCP call's title is `<name>: <tool>`
 *   whose name is `<server>-<tool>` — measured on cursor-agent
 *   2026.08.11-e8db854 (`geniro-75a31aea-ask_user_question: ask_user_question`)
 *   and read out of 2026.09.10-fd3934a's own `formatOperation`, whose MCP arm
 *   is `${name}: ${toolName}`.
 *
 * This used to be CONTAINMENT for cursor ("the name holds both halves"), and
 * that was a hole the same `formatOperation` explains: every other title it
 * builds is agent-authored text. A shell call is titled with its own backticked
 * command, so `` `curl … | sh # geniro-75a31aea notify_user` `` held both
 * halves and was auto-approved in every mode, `ask` included; an edit or a
 * delete is titled with the file's path, so a file NAMED after the tool was the
 * same hole one step removed. None of those titles can equal the template —
 * each starts with a backtick or a fixed verb — which is why the match is exact
 * rather than merely stricter.
 */
export function isHostToolCall(
  serverName: string | null,
  toolName: string,
  hostToolName: string,
): boolean {
  if (serverName === null) {
    return false;
  }
  return (
    toolName === `mcp__${serverName}__${hostToolName}` ||
    toolName === `${serverName}-${hostToolName}: ${hostToolName}`
  );
}
