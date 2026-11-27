import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { librarySlugOf } from '../../agents/utils/run-kind';
import type { AgentKind, AnalysisPurpose } from '../../runs/runs.types';

export interface UsageRunFacts {
  teamSlug: string | null;
  agentKind: AgentKind | null;
  createdAt: Date;
  projectId: string | null;
  analysisPurpose: AnalysisPurpose | null;
  analysisTeamSlug: string | null;
}

/**
 * What the stats observers key a run's rows by — its team, agent, project and
 * analysis purpose, and each member's agent — read once per run and forgotten
 * when the run is deleted.
 */
@Injectable()
export class UsageRunFactsService implements OnModuleInit {
  private readonly runs = new Map<string, UsageRunFacts>();
  private readonly members = new Map<string, AgentKind | null>();

  constructor(
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
    private readonly runDao: RunDao,
    private readonly nodeStateDao: NodeStateDao,
  ) {}

  onModuleInit(): void {
    this.bus.allDeleted().subscribe((runId) => {
      this.forget(runId);
    });
  }

  /** The run's facts; null for a run already gone. */
  async run(runId: string, em?: EntityManager): Promise<UsageRunFacts | null> {
    const cached = this.runs.get(runId);
    if (cached !== undefined) {
      return cached;
    }
    const [run] = await this.runDao.usageFacts([runId], em ?? this.em.fork());
    if (run === undefined) {
      return null;
    }
    const facts: UsageRunFacts = {
      teamSlug: librarySlugOf(run.teamId),
      agentKind: run.agentKind,
      createdAt: run.createdAt,
      projectId: run.projectId,
      analysisPurpose: run.analysisPurpose,
      analysisTeamSlug: run.analysisTeamSlug,
    };
    this.runs.set(runId, facts);
    return facts;
  }

  /** The agent a member runs on; the run's own for a chat's agent. */
  async agentOf(
    runId: string,
    memberId: string | null,
    run: UsageRunFacts,
    em?: EntityManager,
  ): Promise<AgentKind | null> {
    if (memberId === null) {
      return run.agentKind;
    }
    const key = `${runId}\u0000${memberId}`;
    if (this.members.has(key)) {
      return this.members.get(key) ?? null;
    }
    const state = await this.nodeStateDao.getByRunNode(
      runId,
      memberId,
      em ?? this.em.fork(),
    );
    const kind = state?.agentKind ?? run.agentKind;
    this.members.set(key, kind);
    return kind;
  }

  private forget(runId: string): void {
    this.runs.delete(runId);
    const prefix = `${runId}\u0000`;
    for (const key of this.members.keys()) {
      if (key.startsWith(prefix)) {
        this.members.delete(key);
      }
    }
  }
}
