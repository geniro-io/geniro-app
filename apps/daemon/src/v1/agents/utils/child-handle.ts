import type { ChildProcess } from 'node:child_process';

import type {
  AgentSpawnInfo,
  AgentTurnHandle,
} from '../adapters/adapter.types';
import { killProcessGroup } from './kill-tree';

/**
 * Wrap a short-lived utility child (`--version`, `mcp list`, `git ls-files`)
 * as an {@link AgentTurnHandle} so it can register with the ProcessRegistry —
 * the "every spawned child is reachable by shutdown/cancel" rule has no
 * short-lived exemption. Registration auto-clears when the child exits.
 *
 * `spawnInfo` is REQUIRED, and that is the whole enforcement: a group-led
 * child needs a group cancel, and an optional parameter would let a
 * registration site silently omit it and revert to a single-PID kill. Pass
 * what `runCommand` handed to `onSpawn`; a child spawned outside that path
 * states `{ processGroup: false }` explicitly. Contract:
 * {@link AgentCommandOptions.processGroup}.
 */
export function childProcessHandle(
  child: ChildProcess,
  spawnInfo: AgentSpawnInfo,
): AgentTurnHandle {
  return {
    done: new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    }),
    cancel: () =>
      spawnInfo.processGroup
        ? killProcessGroup(child.pid, 'SIGKILL', () => child.kill('SIGKILL'))
        : void child.kill('SIGKILL'),
    respondApproval: () => false,
    // A utility child (a `--version` probe, an `mcp list`) is not a
    // conversation — there is no turn for a user message to join.
    sendUserMessage: () => false,
  };
}
