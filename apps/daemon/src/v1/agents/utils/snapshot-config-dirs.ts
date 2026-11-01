import { type AgentKind, AgentKindSchema } from '../../runs/runs.types';
import { asArray, asRecord, asString, parseJsonColumn } from './json-util';

/**
 * The members of a run's `Run.teamSnapshot` — or, for a run started while
 * teams were node graphs, its agent nodes, whose agents carried the same id, CLI,
 * profile and pool fields (a trigger or instruction node has none, and falls
 * out of every reader below).
 *
 * Read here rather than through the teams module's snapshot parser, because
 * that module imports this one and not the other way round — and only these
 * fields are needed.
 */
function snapshotMembers(snapshot: string | null): unknown[] {
  const record = asRecord(parseJsonColumn(snapshot));
  return Array.isArray(record?.members)
    ? record.members
    : asArray(record?.nodes);
}

/**
 * Each member's config directory, read out of a run's snapshot — the copy of
 * the team the run actually RAN, which is where a member's profile is fixed
 * (the run row carries none of its own). A member naming no directory, and a
 * snapshot that cannot be read, both leave the member out: the caller then
 * uses the CLI's own default profile, which is the one that member ran under.
 */
export function snapshotNodeConfigDirs(
  snapshot: string | null,
): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const entry of snapshotMembers(snapshot)) {
    const node = asRecord(entry);
    const id = node ? asString(node.id) : null;
    const configDir = node ? asString(node.configDir) : null;
    if (id && configDir && configDir.trim() !== '') {
      dirs.set(id, configDir);
    }
  }
  return dirs;
}

/** One configuration a pooled member may have run a conversation under. */
export interface SnapshotPoolProfile {
  agentKind: AgentKind;
  configDir: string | null;
  model: string | null;
}

/**
 * Every configuration of each POOLED team member — its own first, then its
 * pool's — read out of the same snapshot. A pooled member's calls ran under
 * whichever member took them, and `node_state` records the sessions but not
 * the member, so each session can only be looked for under all of them.
 * Members with no pool are left out; {@link snapshotNodeConfigDirs} answers for
 * those.
 */
export function snapshotNodePoolProfiles(
  snapshot: string | null,
): Map<string, (SnapshotPoolProfile | null)[]> {
  const profiles = new Map<string, (SnapshotPoolProfile | null)[]>();
  for (const entry of snapshotMembers(snapshot)) {
    const node = asRecord(entry);
    const id = node ? asString(node.id) : null;
    const pool = node ? asArray(node.pool) : [];
    if (!node || !id || pool.length === 0) {
      continue;
    }
    // By POSITION, an unreadable member kept as null: member N is entry N-1.
    profiles.set(
      id,
      [node, ...pool.map((member) => asRecord(member))].map((member) =>
        profileOf(member),
      ),
    );
  }
  return profiles;
}

function profileOf(
  member: Record<string, unknown> | null,
): SnapshotPoolProfile | null {
  const agent = AgentKindSchema.safeParse(member?.agent);
  if (!member || !agent.success) {
    return null;
  }
  const configDir = asString(member.configDir);
  return {
    agentKind: agent.data,
    configDir: configDir && configDir.trim() !== '' ? configDir : null,
    model: asString(member.model),
  };
}

/** Each pooled member's pool CLIs, every pool member's that could be read. */
export function snapshotPoolKinds(
  snapshot: string | null,
): Map<string, AgentKind[]> {
  return new Map(
    [...snapshotNodePoolProfiles(snapshot)].map(([memberId, profiles]) => [
      memberId,
      profiles.flatMap((profile) => (profile ? [profile.agentKind] : [])),
    ]),
  );
}

/**
 * The CLI, profile and model pool member `member` (1-based) of `nodeId` ran
 * under, or null when that member has no pool — its own `node_state` stamp is
 * then the whole answer. A pooled member's stamp is pool member 1's, so anything
 * about one of its conversations has to ask which member held it.
 */
export function snapshotMemberProfile(
  snapshot: string | null,
  memberId: string,
  member: number,
): SnapshotPoolProfile | null {
  return snapshotNodePoolProfiles(snapshot).get(memberId)?.[member - 1] ?? null;
}
