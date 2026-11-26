import { z } from 'zod';

import type { DaemonHandle, SemanticSearchSources } from '../shared/contracts';
import { DaemonConfigPush } from './daemon-config-push';
import type { ReadyModel } from './search-model/search-model-downloader';

const STATUS_TIMEOUT_MS = 5_000;

/** The body of `PUT /v1/embeddings/config`. */
export interface SearchConfig {
  enabled: boolean;
  sources: SemanticSearchSources;
  chatWindowDays: number | null;
  model: EmbeddingModelRef | null;
  pendingModel: EmbeddingModelRef | null;
  onBattery: boolean;
}

export interface EmbeddingModelRef {
  id: string;
  revision: string;
  dir: string;
  dim: number;
}

export interface SearchConfigInput {
  /** The `semanticSearch.enabled` switch. */
  switchOn: boolean;
  sources: SemanticSearchSources;
  /** Days back the chats indexed by meaning reach; null is all time. */
  chatWindowDays: number | null;
  model: ReadyModel | null;
  pendingModel: ReadyModel | null;
  onBattery: boolean;
}

function refOf(model: ReadyModel | null): EmbeddingModelRef | null {
  return model === null
    ? null
    : {
        id: model.id,
        revision: model.revision,
        dir: model.dir,
        dim: model.dim,
      };
}

/**
 * Search is on only while the switch is on AND a model is ready to read.
 *
 * TWIN PARSER: `EmbeddingConfigSchema` in `apps/daemon/src/v1/embeddings/embeddings.types.ts`.
 */
export function searchConfigOf(input: SearchConfigInput): SearchConfig {
  return {
    enabled: input.switchOn && input.model !== null,
    sources: input.sources,
    chatWindowDays: input.chatWindowDays,
    model: refOf(input.model),
    pendingModel: refOf(input.pendingModel),
    onBattery: input.onBattery,
  };
}

const statusSchema = z.object({
  pendingModel: z.object({ complete: z.boolean() }).nullable(),
});

/**
 * Hands the daemon the search settings (`PUT /v1/embeddings/config`), and asks
 * it whether a pending model is fully indexed. See {@link DaemonConfigPush}.
 */
export class SearchConfigPush extends DaemonConfigPush<SearchConfig> {
  constructor(
    report: (message: string) => void,
    private readonly statusFetch: typeof fetch = fetch,
  ) {
    super(
      {
        path: '/v1/embeddings/config',
        what: 'the search settings',
        untilSaved:
          'the daemon keeps search by meaning off until they are saved again',
      },
      report,
      statusFetch,
    );
  }

  /** False while the daemon is unreachable or has no pending model: the caller asks again later. */
  async pendingIndexComplete(handle: DaemonHandle | null): Promise<boolean> {
    if (handle === null) {
      return false;
    }
    const response = await this.statusFetch(
      `http://${handle.host}:${handle.port}/v1/embeddings/status`,
      {
        headers: { authorization: `Bearer ${handle.token}` },
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return false;
    }
    const parsed = statusSchema.safeParse(await response.json());
    return parsed.success && parsed.data.pendingModel?.complete === true;
  }
}
