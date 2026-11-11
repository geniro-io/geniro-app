import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import type { AgentKind } from '../../runs/runs.types';
import { sanitizeModelParameters } from '../utils/model-parameters';
import { resolveValidConfigDir } from '../utils/resolve-config-dir';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { EffortsService } from './efforts.service';

/** The CLI and model settings of one question, as a chat's (`createChatSchema`). */
export interface OneShotAskChoice {
  agentKind: AgentKind;
  model?: string;
  effort?: string;
  contextWindow?: string;
  modelParameters?: Record<string, string>;
  configDir?: string;
}

/**
 * One question to one CLI with no session and no geniro tools
 * (`AgentAdapter.askOnce`), for the advice the memory screens ask for: the
 * import's Sort with AI and the cleanup's check. Every choice is checked
 * before anything is spawned; the answer is billed to the profile asked under.
 */
@Injectable()
export class OneShotAskService {
  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly efforts: EffortsService,
  ) {}

  /** The CLIs that answer a one-shot question. */
  agents(): AgentKind[] {
    return [...this.adapters.all()]
      .filter(
        ([, adapter]) =>
          adapter.getConfig().oneShotAskUnavailableReason === null,
      )
      .map(([agentKind]) => agentKind);
  }

  /**
   * The CLI's answer, or null when it gave none. A CLI that cannot answer is
   * refused as `unavailable.code`, "<cli> cannot <unavailable.task>"; a
   * profile or an effort it does not take is a 400 too.
   */
  async ask(
    choice: OneShotAskChoice,
    prompt: string,
    unavailable: { code: string; task: string },
  ): Promise<string | null> {
    if (!this.agents().includes(choice.agentKind)) {
      throw new BadRequestException(
        unavailable.code,
        `${choice.agentKind} cannot ${unavailable.task}`,
      );
    }
    const adapter = this.adapters.for(choice.agentKind);
    const model = choice.model ?? null;
    let configDir: string | null = null;
    if (choice.configDir !== undefined) {
      const reason = adapter.getConfig().configDir.unavailableReason;
      if (reason !== null) {
        throw new BadRequestException('CONFIG_DIR_UNSUPPORTED', reason);
      }
      configDir = resolveValidConfigDir(choice.configDir);
    }
    if (
      choice.effort !== undefined &&
      !this.efforts.accepts(choice.agentKind, choice.effort, model, configDir)
    ) {
      throw new BadRequestException(
        'EFFORT_UNSUPPORTED',
        `${choice.agentKind} does not accept the reasoning effort '${choice.effort}'`,
      );
    }
    return adapter.askOnce({
      prompt,
      model,
      configDir,
      effort: choice.effort ?? null,
      contextWindow: choice.contextWindow ?? null,
      modelParameters: sanitizeModelParameters(choice.modelParameters),
    });
  }
}
