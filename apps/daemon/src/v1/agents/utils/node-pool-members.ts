import type { AgentKind } from '../../runs/runs.types';
import { asRecord, parseJsonColumn } from './json-util';
import {
  snapshotMemberProfile,
  snapshotNodePoolProfiles,
  type SnapshotPoolProfile,
} from './snapshot-config-dirs';

type HandOffRow = { memberId: string | null; payload: string };

function memberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/**
 * The pool profile a pooled member's own conversation runs on now: the member
 * its last hand-off recorded (member 1 before any), provided that profile is
 * the CLI and model its `node_state` stamp says ran. Null for a member with no
 * pool, or when the stamp names another profile. The hand-off rows are read
 * only for a pooled member.
 */
export async function pooledOwnProfile(
  snapshot: string | null,
  memberId: string,
  stamp: { agentKind: AgentKind; model: string | null },
  handOffRows: () => Promise<readonly HandOffRow[]>,
): Promise<SnapshotPoolProfile | null> {
  if (!snapshotNodePoolProfiles(snapshot).has(memberId)) {
    return null;
  }
  const member = readNodePoolMembers(await handOffRows()).get(memberId) ?? 1;
  const profile = snapshotMemberProfile(snapshot, memberId, member);
  return profile?.agentKind === stamp.agentKind && profile.model === stamp.model
    ? profile
    : null;
}

/** The last explicit hand-off of each member's own conversation, in row order. */
export function readNodePoolMembers(
  rows: readonly HandOffRow[],
): Map<string, number> {
  const members = new Map<string, number>();
  for (const row of rows) {
    const payload = asRecord(parseJsonColumn(row.payload));
    const member = memberOf(payload?.member);
    if (
      row.memberId !== null &&
      payload?.nodePoolHandOff === true &&
      payload.callId === undefined &&
      member !== null
    ) {
      members.set(row.memberId, member);
    }
  }
  return members;
}

/**
 * The members whose last explicit hand-off was the user pinning a pool member,
 * each with whether that pin moved its conversation off another member.
 */
export function readNodePoolPins(
  rows: readonly HandOffRow[],
): Map<string, boolean> {
  const pinned = new Map<string, boolean>();
  for (const row of rows) {
    const payload = asRecord(parseJsonColumn(row.payload));
    const member = memberOf(payload?.member);
    if (
      row.memberId === null ||
      payload?.nodePoolHandOff !== true ||
      payload.callId !== undefined ||
      member === null
    ) {
      continue;
    }
    if (payload.pinnedByUser === true) {
      pinned.set(row.memberId, memberOf(payload.fromMember) !== member);
    } else {
      pinned.delete(row.memberId);
    }
  }
  return pinned;
}

/** A historical own session can belong to a pool member the member no longer uses. */
export function nodePoolSessionMember(
  rows: readonly HandOffRow[],
  memberId: string,
  sessionId: string,
): number | null {
  let member: number | null = null;
  for (const row of rows) {
    if (row.memberId !== memberId) {
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
