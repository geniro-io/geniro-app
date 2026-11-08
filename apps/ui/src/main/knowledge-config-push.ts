import type { KnowledgeSettings } from '../shared/contracts';
import { DaemonConfigPush } from './daemon-config-push';

/**
 * Hands the daemon the user's knowledge settings (`PUT /v1/knowledge/config`) —
 * see {@link DaemonConfigPush}. Until the first push lands the daemon keeps
 * knowledge on, with agent writes waiting for review.
 *
 * TWIN PARSER: `KnowledgeConfigSchema` in `apps/daemon/src/v1/knowledge/knowledge.types.ts`.
 */
export class KnowledgeConfigPush extends DaemonConfigPush<KnowledgeSettings> {
  constructor(
    report: (message: string) => void,
    fetchImpl: typeof fetch = fetch,
  ) {
    super(
      {
        path: '/v1/knowledge/config',
        what: 'the knowledge settings',
        untilSaved:
          'the daemon keeps its previous knowledge settings until they are saved again',
      },
      report,
      fetchImpl,
    );
  }
}
