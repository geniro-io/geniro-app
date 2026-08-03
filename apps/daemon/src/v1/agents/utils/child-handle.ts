import type { ChildProcess } from 'node:child_process';

import type { AgentTurnHandle } from '../adapters/adapter.types';
import { killProcessGroup } from './kill-tree';

/** How much of the child's tree {@link childProcessHandle} cancel reaches. */
export interface ChildProcessHandleOptions {
  /**
   * Signal the child's whole process GROUP on cancel instead of just its pid.
   *
   * Only correct for a child spawned as a group leader
   * (`AgentCommandOptions.processGroup`), which is why it is opt-in rather than
   * the default: a command that forks nothing has no group to reap, and the
   * two flags are documented as a pair on that option.
   */
  processGroup?: boolean;
}

/**
 * Wrap a short-lived utility child (`--version`, `mcp list`, `git ls-files`)
 * as an {@link AgentTurnHandle} so it can register with the ProcessRegistry —
 * the "every spawned child is reachable by shutdown/cancel" rule has no
 * short-lived exemption. Registration auto-clears when the child exits.
 *
 * The default cancel is a single-PID kill, which is the whole truth for a
 * command that spawns nothing of its own. A command that DOES fork — a health
 * check that launches the user's MCP servers — must be spawned as a group
 * leader and wrapped with `{ processGroup: true }`, or cancel and shutdown
 * leave those grandchildren running (see `kill-tree.ts`).
 */
export function childProcessHandle(
  child: ChildProcess,
  options: ChildProcessHandleOptions = {},
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
