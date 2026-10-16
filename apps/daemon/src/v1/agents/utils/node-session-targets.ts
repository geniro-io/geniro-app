import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import { type SessionTranscriptTarget, SINGLE_AGENT_NODE } from '../chat.types';
import { readNodeSessions } from './node-sessions';
import {
  snapshotNodeConfigDirs,
  snapshotNodePoolProfiles,
} from './snapshot-config-dirs';

/** A run's snapshot profiles, read once for all of its nodes. */
export interface RunSnapshotProfiles {
  dirs: ReturnType<typeof snapshotNodeConfigDirs>;
  pools: ReturnType<typeof snapshotNodePoolProfiles>;
}

export function runSnapshotProfiles(
  snapshot: string | null,
): RunSnapshotProfiles {
  return {
    dirs: snapshotNodeConfigDirs(snapshot),
    pools: snapshotNodePoolProfiles(snapshot),
  };
}

/**
 * Every CLI conversation one node of a run held, with the CLI and the profile
 * it lives under.
 *
 * A chat's one node runs under the run's own profile; a workflow node under
 * the one its snapshot names. A node's whole session history is taken, not
 * only the session it would resume: every call to it and every compaction
 * starts another conversation, and each is a transcript on disk.
 */
export function nodeSessionTargets(
  run: Pick<Run, 'agentKind' | 'configDir' | 'workflowId' | 'workflowSnapshot'>,
  state: Pick<
    NodeState,
    'nodeId' | 'agentKind' | 'agentSessionId' | 'sessionIds'
  >,
  profiles: RunSnapshotProfiles = runSnapshotProfiles(run.workflowSnapshot),
): SessionTranscriptTarget[] {
  const agentKind = state.agentKind ?? run.agentKind;
  if (agentKind === null) {
    return [];
  }
  const configDir =
    run.workflowId === null && state.nodeId === SINGLE_AGENT_NODE
      ? run.configDir
      : (profiles.dirs.get(state.nodeId) ?? null);
  const sessions = new Set(readNodeSessions(state.sessionIds));
  if (state.agentSessionId) {
    sessions.add(state.agentSessionId);
  }
  // A pooled node's sessions belong to whichever member ran them, which
  // `node_state` does not record — so each is looked for under every
  // member's profile.
  const members = profiles.pools.get(state.nodeId) ?? [
    { agentKind, configDir },
  ];
  return [...sessions].flatMap((sessionId) =>
    members.flatMap((profile) =>
      profile === null
        ? []
        : [
            {
              agentKind: profile.agentKind,
              configDir: profile.configDir,
              sessionId,
            },
          ],
    ),
  );
}
