import { asRecord, parseJsonColumn } from './json-util';

function memberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/** The last explicit hand-off of each node's own conversation, in row order. */
export function readNodePoolMembers(
  rows: readonly { nodeId: string | null; payload: string }[],
): Map<string, number> {
  const members = new Map<string, number>();
  for (const row of rows) {
    const payload = asRecord(parseJsonColumn(row.payload));
    const member = memberOf(payload?.member);
    if (
      row.nodeId !== null &&
      payload?.nodePoolHandOff === true &&
      payload.callId === undefined &&
      member !== null
    ) {
      members.set(row.nodeId, member);
    }
  }
  return members;
}

/** A historical own session can belong to a member the node no longer uses. */
export function nodePoolSessionMember(
  rows: readonly { nodeId: string | null; payload: string }[],
  nodeId: string,
  sessionId: string,
): number | null {
  let member: number | null = null;
  for (const row of rows) {
    if (row.nodeId !== nodeId) {
      continue;
    }
    const payload = asRecord(parseJsonColumn(row.payload));
    if (payload === null || payload.callId !== undefined) {
      continue;
    }
    if (
      payload.nodePoolHandOff === true &&
      payload.previousSessionId === sessionId
    ) {
      member = memberOf(payload.fromMember) ?? member;
    } else if (payload.sessionId === sessionId) {
      member = memberOf(payload.nodePoolMember) ?? member;
    }
  }
  return member;
}
