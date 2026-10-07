import { type AgentKind, AgentKindSchema } from '../../runs/runs.types';
import { asArray, asRecord, asString, parseJsonColumn } from './json-util';

/**
 * Each agent node's config directory, read out of a run's
 * `Run.workflowSnapshot` — the copy of the workflow the run actually RAN, which
 * is where a workflow node's profile is fixed (the run row carries none of its
 * own).
 *
 * Read here rather than through the graphs module's snapshot parser, because
 * that module imports this one and not the other way round — and only these two
 * fields are needed. A node naming no directory, and a snapshot that cannot be
 * read, both leave the node out: the caller then uses the CLI's own default
 * profile, which is the one that node ran under.
 */
export function snapshotNodeConfigDirs(
  snapshot: string | null,
): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const entry of asArray(asRecord(parseJsonColumn(snapshot))?.nodes)) {
    const node = asRecord(entry);
    const id = node ? asString(node.id) : null;
    const configDir = node ? asString(node.configDir) : null;
    if (id && configDir && configDir.trim() !== '') {
      dirs.set(id, configDir);
    }
  }
  return dirs;
}

/** One configuration a pooled node may have run a conversation under. */
export interface SnapshotPoolProfile {
  agentKind: AgentKind;
  configDir: string | null;
  model: string | null;
}

/**
 * Every configuration of each POOLED agent node — its own first, then its
 * pool's — read out of the same snapshot. A pooled node's calls ran under
 * whichever member took them, and `node_state` records the sessions but not
 * the member, so each session can only be looked for under all of them.
 * Nodes with no pool are left out; {@link snapshotNodeConfigDirs} answers for
 * those.
 */
export function snapshotNodePoolProfiles(
  snapshot: string | null,
): Map<string, (SnapshotPoolProfile | null)[]> {
  const profiles = new Map<string, (SnapshotPoolProfile | null)[]>();
  for (const entry of asArray(asRecord(parseJsonColumn(snapshot))?.nodes)) {
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

/** Each pooled node's member CLIs, every member's that could be read. */
export function snapshotPoolKinds(
  snapshot: string | null,
): Map<string, AgentKind[]> {
  return new Map(
    [...snapshotNodePoolProfiles(snapshot)].map(([nodeId, profiles]) => [
      nodeId,
      profiles.flatMap((profile) => (profile ? [profile.agentKind] : [])),
    ]),
  );
}

/**
 * The CLI, profile and model pool member `member` (1-based) of `nodeId` ran
 * under, or null when that node has no pool — its own `node_state` stamp is
 * then the whole answer. A pooled node's stamp is member 1's, so anything
 * about one of its conversations has to ask which member held it.
 */
export function snapshotMemberProfile(
  snapshot: string | null,
  nodeId: string,
  member: number,
): SnapshotPoolProfile | null {
  return snapshotNodePoolProfiles(snapshot).get(nodeId)?.[member - 1] ?? null;
}
