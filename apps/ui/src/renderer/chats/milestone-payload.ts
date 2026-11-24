/**
 * What a `milestone` row's payload says: one step an agent reported to its
 * run's timeline — progress, a problem it found, or a thing it finished.
 *
 * TWIN PARSER: `MilestonePayloadSchema` in
 * `apps/daemon/src/v1/agents/chat.types.ts`, which writes these rows. An item
 * payload is `z.unknown()` on the wire, so the two sides read one shape
 * independently; a field renamed there must change here.
 */

export const MILESTONE_KINDS = ['progress', 'problem', 'done'] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

export interface MilestonePayload {
  text: string;
  kind: MilestoneKind;
  nodeId: string;
  /** The writing conversation; null for the node's own. */
  conversationId: string | null;
  /** The call that conversation was answering, when it was one. */
  callId?: string;
}

const KINDS: ReadonlySet<string> = new Set(MILESTONE_KINDS);

/** The step a row carries, or null when its payload is not one. */
export function readMilestonePayload(
  payload: unknown,
): MilestonePayload | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const bag = payload as Record<string, unknown>;
  if (
    typeof bag.kind !== 'string' ||
    !KINDS.has(bag.kind) ||
    typeof bag.text !== 'string' ||
    bag.text.trim() === '' ||
    typeof bag.nodeId !== 'string' ||
    (bag.conversationId !== null && typeof bag.conversationId !== 'string') ||
    (bag.callId !== undefined && typeof bag.callId !== 'string')
  ) {
    return null;
  }
  return {
    text: bag.text,
    kind: bag.kind as MilestoneKind,
    nodeId: bag.nodeId,
    conversationId: bag.conversationId,
    ...(bag.callId === undefined ? {} : { callId: bag.callId }),
  };
}
