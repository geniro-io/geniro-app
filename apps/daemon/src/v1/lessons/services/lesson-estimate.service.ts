import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { ItemDao } from '../../agents/dao/item.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { tokenCostUsd } from '../../agents/utils/model-prices';
import { MemoryService } from '../../memory/services/memory.service';
import type { Run } from '../../runs/entity/run.entity';
import type { LessonEstimate, ReflectLessons } from '../lessons.types';
import { lessonsReflectionGuide } from '../utils/lessons-reflection-guide';
import { reflectionChoiceOf } from '../utils/reflection-choice';
import { LessonsConfigService } from './lessons-config.service';

/** What a reflection reads besides the stretch: the CLI's own system prompt and tool schemas, the brief, the rows around it. */
export const LESSON_READ_OVERHEAD_TOKENS = 30_000;
/** How many times a reflection's turns read that context again, one tool call after another. */
export const LESSON_READ_PASSES = 4;
/** What a reflection writes: its reasoning and one `propose_lessons` call. */
export const LESSON_ANSWER_TOKENS = 4_000;
const CHARS_PER_TOKEN = 4;

/**
 * Prices a reflection before it runs: the stretch's stored characters and the
 * guide's plus a fixed allowance for the CLI's own context, read once per
 * pass of its tool calls, at the list price of the model it would run as. No list price (cursor-agent, an unlisted id) prices
 * nothing — tokens only, never $0.
 */
@Injectable()
export class LessonEstimateService {
  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly adapters: AgentAdapterRegistry,
    private readonly memory: MemoryService,
    private readonly config: LessonsConfigService,
  ) {}

  async estimate(
    source: Pick<Run, 'id' | 'agentKind' | 'configDir'>,
    range: { fromSeq: number; toSeq: number },
    input: Pick<ReflectLessons, 'agentKind' | 'model'> = {},
    em: EntityManager = this.em.fork(),
  ): Promise<LessonEstimate> {
    const choice = reflectionChoiceOf(this.config.config, source, input);
    const adapter = this.adapters.for(choice.agentKind);
    const model = await adapter
      .resolveModel(choice.model, choice.configDir)
      .catch(() => choice.model);
    const chars = await this.itemDao.payloadCharsBetween(
      source.id,
      range.fromSeq,
      range.toSeq,
      em,
    );
    const inputTokens =
      (Math.ceil(
        (chars + lessonsReflectionGuide(this.memory.enabled).length) /
          CHARS_PER_TOKEN,
      ) +
        LESSON_READ_OVERHEAD_TOKENS) *
      LESSON_READ_PASSES;
    const rates = adapter.billingRatesOf(model);
    return {
      agentKind: choice.agentKind,
      model,
      tokens: inputTokens + LESSON_ANSWER_TOKENS,
      usd:
        rates === null
          ? null
          : tokenCostUsd(rates, {
              inputTokens,
              outputTokens: LESSON_ANSWER_TOKENS,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            }),
    };
  }
}
