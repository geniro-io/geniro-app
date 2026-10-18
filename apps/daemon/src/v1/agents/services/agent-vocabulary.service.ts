import { Injectable, Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentVocabularyWire } from '../chat.types';
import { ContextWindowsService } from './context-windows.service';
import { EffortsService } from './efforts.service';
import { ModelParametersService } from './model-parameters.service';
import { ModelsService } from './models.service';

/**
 * A model picker's whole vocabulary in one answer — see
 * `AgentVocabularyWireSchema` for why it is one.
 *
 * Composes only: each part is still asked of the service that owns it, with
 * that service's own cache, single-flight and TTL, so this adds no second
 * cache and no second idea of when an answer is stale. The four are asked at
 * once — the slowest decides when the answer lands, which is when the picker
 * could show all four anyway.
 */
@Injectable()
export class AgentVocabularyService {
  private readonly logger = new Logger(AgentVocabularyService.name);

  constructor(
    private readonly models: ModelsService,
    private readonly efforts: EffortsService,
    private readonly contextWindows: ContextWindowsService,
    private readonly modelParameters: ModelParametersService,
  ) {}

  /**
   * Every part, or `null` for a part that alone could not be read. When NONE
   * could, the first reason is thrown instead: that is a question the daemon
   * could not answer at all (an unusable config directory, an unknown CLI),
   * and the caller is owed its error rather than four nulls.
   */
  async read(
    kind: AgentKind,
    model: string | null,
    configDir: string | null,
  ): Promise<AgentVocabularyWire> {
    const [models, efforts, contextWindows, modelParameters] =
      await Promise.allSettled([
        this.models.list(kind, configDir),
        this.efforts.list(kind, model, configDir),
        this.contextWindows.listWire(kind, model, configDir),
        this.modelParameters.listWire(kind, model, configDir),
      ]);
    const parts = { models, efforts, contextWindows, modelParameters };
    const failed = Object.entries(parts).filter(
      (entry): entry is [string, PromiseRejectedResult] =>
        entry[1].status === 'rejected',
    );
    if (failed.length === Object.keys(parts).length) {
      throw failed[0]![1].reason;
    }
    for (const [name, result] of failed) {
      this.logger.warn(
        `${kind}: the ${name} part of the vocabulary could not be read: ${
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        }`,
      );
    }
    return {
      models: models.status === 'fulfilled' ? models.value : null,
      efforts:
        efforts.status === 'fulfilled'
          ? {
              efforts: efforts.value.efforts,
              unavailableReason: efforts.value.unavailableReason,
            }
          : null,
      contextWindows:
        contextWindows.status === 'fulfilled' ? contextWindows.value : null,
      modelParameters:
        modelParameters.status === 'fulfilled' ? modelParameters.value : null,
    };
  }
}
