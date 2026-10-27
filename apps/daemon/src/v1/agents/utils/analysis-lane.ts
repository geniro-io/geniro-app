/**
 * The chat's own lane, as an analysis names it — a chat's rows carry no node.
 * A read takes it back as a `nodeId`, so every answer spells it this way.
 */
export const CHAT_LANE = 'agent';

/** A node as an analysis names it. */
export function laneOf(nodeId: string | null): string {
  return nodeId ?? CHAT_LANE;
}
