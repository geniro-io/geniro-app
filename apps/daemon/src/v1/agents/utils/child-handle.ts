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
 * Pass the `AgentSpawnInfo` `runCommand` handed to `onSpawn` rather than
 * writing one: a group-led child needs a group cancel, and taking that fact
 * from the spawn itself is what stops the two disagreeing. Contract:
 * {@link AgentCommandOptions.processGroup}.
 */
export function childProcessHandle(
  child: ChildProcess,
  options: Partial<AgentSpawnInfo> = {},
): AgentTurnHandle {
  return {
    done: new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    }),
    cancel: () =>
      options.processGroup === true
        ? killProcessGroup(child.pid, 'SIGKILL', () => child.kill('SIGKILL'))
        : void child.kill('SIGKILL'),
    respondApproval: () => false,
  };
}
