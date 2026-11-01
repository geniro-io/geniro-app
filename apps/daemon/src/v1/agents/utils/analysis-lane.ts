/**
 * The chat's own lane, as an analysis names it — a chat's rows carry no member.
 * A read takes it back as a `nodeId`, so every answer spells it this way.
 */
export const CHAT_LANE = 'agent';

/** A member as an analysis names it. */
export function laneOf(memberId: string | null): string {
  return memberId ?? CHAT_LANE;
}
