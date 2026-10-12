import type { McpTurnMismatch } from '../chat.types';

/**
 * The transcript sentence for a turn that started without servers geniro's
 * own reading said were connected (`AgentMcpService.observeTurnServers`), or
 * null when there is nothing to say.
 *
 * Either way the session that reported it has been retired, so the next turn
 * starts a process that dials those servers again — "turn" rather than "your
 * message", since on a workflow callee the user's message goes elsewhere.
 * What differs is whether a record the CLI kept was the reason.
 */
export function mcpMismatchNotice(seen: McpTurnMismatch): string | null {
  if (seen.missing.length === 0) {
    return null;
  }
  const one = seen.missing.length === 1;
  const names = seen.missing.join(', ');
  const it = one ? 'it' : 'them';
  const lead = `${names} showed as connected but ${one ? 'was' : 'were'} not loaded in this turn`;
  return seen.cleared.length > 0
    ? `${lead} — the agent's CLI still had ${it} marked as needing sign-in. Geniro cleared that, so the next turn starts a fresh session with ${it}.`
    : `${lead} — the agent's CLI reported ${it} as needing sign-in. The next turn starts a fresh session that connects again; if ${one ? 'it is' : 'they are'} still missing then, re-check ${it} in the MCP panel.`;
}
