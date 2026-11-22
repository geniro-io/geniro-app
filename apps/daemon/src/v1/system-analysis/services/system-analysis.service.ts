import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Optional } from '@nestjs/common';
import { ConflictException } from '@packages/common';

import {
  ANALYSIS_DEFAULT_APPROVAL,
  type RunWire,
} from '../../agents/chat.types';
import { ChatService } from '../../agents/services/chat.service';
import {
  systemAnalysisBrief,
  systemAnalysisGuide,
} from '../../agents/utils/thread-analysis-guide';
import { MemoryService } from '../../memory/services/memory.service';
import type { Run } from '../../runs/entity/run.entity';
import { TeamRecommendationDao } from '../../stats/dao/team-recommendation.dao';
import type { TeamRecommendationRow } from '../../stats/stats.types';
import {
  type StartSystemAnalysis,
  type SystemAnalysisList,
  type SystemAnalysisRow,
  type SystemAnalysisScope,
  type SystemAnalysisStatus,
  type SystemDigest,
  SystemDigestSchema,
} from '../system-analysis.types';
import { ensureSystemAnalysisFolder } from '../utils/system-analysis-folder';
import { SystemAnalysisEventBus } from './system-analysis-events.bus';
import { SystemDigestService, systemPeriodOf } from './system-digest.service';

/**
 * Settings' system analysis: what a period holds, starting an analysis over
 * it, and the analyses run before. Each analysis is a hidden chat of its own,
 * kept like every analysis; nothing here starts one but the user's press.
 */
@Injectable()
export class SystemAnalysisService {
  constructor(
    private readonly em: EntityManager,
    private readonly digests: SystemDigestService,
    private readonly chats: ChatService,
    private readonly ledger: TeamRecommendationDao,
    private readonly memory: MemoryService,
    private readonly events: SystemAnalysisEventBus,
    /** The analyses' working folder; a test seam. */
    @Optional() private readonly folder?: string,
  ) {}

  async scope(days: number): Promise<SystemAnalysisScope> {
    const { digest } = await this.digests.build(systemPeriodOf(days));
    return {
      period: digest.period,
      totals: digest.totals,
      threads: digest.threads,
    };
  }

  async start(input: StartSystemAnalysis): Promise<RunWire> {
    const { days, ...setup } = input;
    const { digest, runs } = await this.digests.build(systemPeriodOf(days));
    if (runs.length === 0) {
      throw new ConflictException(
        'SYSTEM_ANALYSIS_NOTHING',
        'no thread in that period shows a sign of trouble — pick a longer period',
      );
    }
    const run = await this.chats.createChat({
      ...setup,
      approval: setup.approval ?? ANALYSIS_DEFAULT_APPROVAL,
      cwd: ensureSystemAnalysisFolder(this.folder),
      projectId: null,
      title: `System analysis · ${days === 1 ? 'last day' : `last ${days} days`}`,
      taskInstructions: systemAnalysisGuide(this.memory.enabled),
      analysisSystem: { runs, digest: JSON.stringify(digest) },
    });
    try {
      await this.chats.sendMessage(
        run.id,
        systemAnalysisBrief({ days, threads: runs.length }),
        [],
      );
    } catch (error) {
      await this.chats.delete(run.id).catch(() => undefined);
      throw error;
    }
    this.events.publishChanged(run.id);
    return run;
  }

  async list(page: {
    limit: number;
    before?: string;
  }): Promise<SystemAnalysisList> {
    const listed = await this.chats.listSystemAnalyses({
      limit: page.limit + 1,
      ...(page.before === undefined ? {} : { before: new Date(page.before) }),
    });
    const shown = listed.slice(0, page.limit);
    const analyses: SystemAnalysisRow[] = [];
    for (const { run, wire } of shown) {
      analyses.push(
        rowOf(run, wire, await this.ledger.rowsOfChat(run.id, this.em.fork())),
      );
    }
    return {
      analyses,
      next:
        listed.length > page.limit
          ? (shown.at(-1)?.wire.createdAt ?? null)
          : null,
    };
  }
}

/** The digest frozen on a system analysis, or null when it does not read. */
export function systemDigestOf(
  run: Pick<Run, 'analysisDigest'>,
): SystemDigest | null {
  if (run.analysisDigest === null) {
    return null;
  }
  try {
    const parsed = SystemDigestSchema.safeParse(JSON.parse(run.analysisDigest));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function rowOf(
  run: Run,
  wire: RunWire,
  items: readonly TeamRecommendationRow[],
): SystemAnalysisRow {
  const digest = systemDigestOf(run);
  const newestCard = items.reduce(
    (max, item) => Math.max(max, item.cardSeq),
    -1,
  );
  const card = items.filter((item) => item.cardSeq === newestCard);
  const filed = card.filter(
    (item) =>
      item.applyAction === 'filed' ||
      item.applyAction === 'start_requested' ||
      item.applyAction === 'started',
  ).length;
  const started = card.filter((item) => item.applyAction === 'started').length;
  const failed = card.filter((item) => item.outcome === 'failed').length;
  return {
    run: wire,
    period: digest?.period ?? null,
    threadsRead: digest?.threads.length ?? 0,
    proposals: card.length,
    status: statusOf(run, card, { filed, started, failed }),
    filed,
    started,
    failed,
  };
}

function statusOf(
  run: Pick<Run, 'status'>,
  card: readonly TeamRecommendationRow[],
  counts: { filed: number; started: number; failed: number },
): SystemAnalysisStatus {
  if (run.status === 'running' || run.status === 'pending') {
    return 'running';
  }
  if (card.some((item) => item.applyAction === 'kept')) {
    return 'kept';
  }
  if (counts.started > 0) {
    return 'started';
  }
  if (counts.filed > 0) {
    return 'filed';
  }
  if (counts.failed > 0 || (card.length === 0 && run.status === 'failed')) {
    return 'failed';
  }
  return 'waiting';
}
