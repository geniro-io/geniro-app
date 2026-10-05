import { join } from 'node:path';

import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

import { environment } from '../environments';
import { AgentSessionRegistry } from '../v1/agents/services/agent-session.registry';
import { ProcessRegistry } from '../v1/agents/services/process-registry';
import { DAEMON_LOCK_FILE_NAME, releaseInstanceLock } from './instance-lock';

/**
 * Releases the instance lock when the daemon shuts down — the sibling of
 * {@link PidfileLifecycle}, and released the same way for the same reason.
 *
 * It has to be a Nest shutdown hook and cannot be a `process.on('exit')`
 * handler, which is what this originally was. Nest's own signal handling
 * removes its listener and RE-RAISES the signal once the hooks have run, so
 * the process is finally terminated by SIGTERM's default action — and default
 * termination does not run `exit` listeners. Observed directly: the pidfile
 * (removed in a hook) was gone after a clean shutdown while the lock file
 * (removed in an exit listener) was still there.
 *
 * Leaving one behind was never a correctness problem — the next launch cannot
 * confirm a dead holder and takes over immediately — but a lock file that
 * outlives every clean stop is residue that makes the directory harder to
 * reason about, and it made this module's own doc claim untrue.
 *
 * Released only once every in-flight turn is drained and every kept agent
 * process signalled, for the pidfile's reason: the lock is what keeps a second
 * daemon off this userData dir, and letting it go first admits one while this
 * daemon's children run.
 */
@Injectable()
export class InstanceLockLifecycle implements OnApplicationShutdown {
  constructor(
    private readonly processes: ProcessRegistry,
    private readonly sessions: AgentSessionRegistry,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    // Started, closed, THEN awaited: closing the kept processes in the same
    // tick the drain starts is what keeps a graceful quit from waiting out the
    // whole drain window, and keeps the close listeners suppressed.
    const drained = this.processes.drain();
    this.sessions.closeAll();
    await drained;
    releaseInstanceLock(join(environment.userDataDir, DAEMON_LOCK_FILE_NAME));
  }
}
