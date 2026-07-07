import type { ChildProcess } from 'node:child_process';

import type { AgentTurnHandle } from '../adapters/adapter.types';

/**
 * Wrap a short-lived utility child (`--version`, `mcp enable`, `git ls-files`)
 * as an {@link AgentTurnHandle} so it can register with the ProcessRegistry —
 * the "every spawned child is reachable by shutdown/cancel" rule has no
 * short-lived exemption. Registration auto-clears when the child exits.
 */
export function childProcessHandle(child: ChildProcess): AgentTurnHandle {
  return {
    done: new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    }),
    cancel: () => child.kill('SIGKILL'),
    respondApproval: () => false,
  };
}
