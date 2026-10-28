import type { MemorySettings } from '../shared/contracts';
import { DaemonConfigPush } from './daemon-config-push';

/**
 * Hands the daemon the user's memory settings (`PUT /v1/memories/config`) — see
 * {@link DaemonConfigPush}. Until the first push lands the daemon keeps memory
 * on with agent writes active.
 *
 * TWIN PARSER: `MemoryConfigSchema` in `apps/daemon/src/v1/memory/memory.types.ts`.
 */
export class MemoryConfigPush extends DaemonConfigPush<MemorySettings> {
  constructor(
    report: (message: string) => void,
    fetchImpl: typeof fetch = fetch,
  ) {
    super(
      {
        path: '/v1/memories/config',
        what: 'the memory settings',
        untilSaved:
          'the daemon keeps its previous memory settings until they are saved again',
      },
      report,
      fetchImpl,
    );
  }
}
