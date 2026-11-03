import { Injectable } from '@nestjs/common';

import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type { AnalysisJudgeCheckWire } from '../teams.types';
import { TeamStoreService } from './team-store.service';

/**
 * Whether an analysis's judge runs the same vendor's models as the members it
 * marks. A judge favours text of its own vendor's models, so the analysis
 * dialog suggests another agent when most of the team shares the judge's.
 */
@Injectable()
export class AnalysisJudgeService {
  constructor(
    private readonly store: TeamStoreService,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  async check(
    slug: string,
    judge: { agent: string; model?: string },
  ): Promise<AnalysisJudgeCheckWire> {
    const { team } = await this.store.get(slug);
    const adapters = [...this.adapters.all()];
    const vendorOf = (agent: string, model: string | null): string | null =>
      adapters.find(([kind]) => kind === agent)?.[1].modelVendorOf(model) ??
      null;
    const judgeVendor = vendorOf(judge.agent, judge.model ?? null);
    return {
      judgeVendor,
      members: team.members.length,
      sameVendor:
        judgeVendor === null
          ? []
          : team.members
              .filter(
                (member) =>
                  vendorOf(member.agent, member.model ?? null) === judgeVendor,
              )
              .map((member) => member.id),
      alternatives: adapters.flatMap(([kind, adapter]) => {
        const vendor = adapter.modelVendorOf(null);
        return vendor !== null && vendor !== judgeVendor ? [kind] : [];
      }),
    };
  }
}
