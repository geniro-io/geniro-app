/**
 * The ONE short word for a CLI, wherever one is stated in a row of chrome.
 *
 * The daemon spells the second CLI `cursor-agent` — the binary's name — and
 * every surface that states it has room for one word beside something else:
 * a sidebar row's labels, a call block's name line. The mapping lived privately
 * in `chat-list-item.tsx` with a note that a third caller is when it becomes
 * shared; the call block's header is that third caller.
 *
 * Null rather than a guess when the kind is unknown or absent, so each caller
 * decides what an unstated agent looks like: the chat row says `agent` (its
 * label slot is fixed), a block header draws nothing at all.
 *
 * Deliberately NOT used by the agents panel, which renders the exact kind in a
 * badge with room for it — shortening there would hide the difference between
 * what the graph says and what a CLI is called.
 */
export function shortAgentLabel(agentKind: string | null): string | null {
  if (agentKind === null || agentKind === '') {
    return null;
  }
  return agentKind === 'cursor-agent' ? 'cursor' : agentKind;
}
