import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { RunItemEvent } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { parseJsonColumn } from '../../agents/utils/json-util';
import type { Run } from '../../runs/entity/run.entity';
import { TeamStoreService } from '../../teams/services/team-store.service';
import { teamVersionOf } from '../../teams/utils/team-version';
import { MemberAssessmentDao } from '../dao/member-assessment.dao';
import { TeamRecommendationDao } from '../dao/team-recommendation.dao';
import type { MemberAssessmentSource } from '../stats.types';
import {
  applyIn,
  assessmentSourceOf,
  filedAssessmentsOf,
  filedRecommendationsOf,
  marksIn,
} from '../utils/recommendation-ledger';

/** One row of a chat, as the ledger reads it. */
interface LedgerRow {
  seq: number;
  kind: string;
  role: string | null;
  createdAt: Date;
  payload: unknown;
}

/**
 * Copies every recommendations card a team's analysis or builder chat
 * files, every Apply that selects from one and every mark of what became of
 * an item into `team_recommendations`, and the member assessments of those
 * cards and of a thread analysis of one of the team's runs into
 * `member_assessments`; both outlive the chat. It
 * OBSERVES the bus like `RunOutcomeLedgerService`: the agents module writes
 * the rows and cannot depend on this module.
 *
 * A chat's rows are copied one at a time, in the order they arrive, so an
 * Apply never lands before the card it selects from. What a crash or a failed
 * write missed is copied at the next launch by the sweep, while the chat still
 * exists.
 */
@Injectable()
export class RecommendationLedgerService implements OnModuleInit {
  private readonly logger = new Logger(RecommendationLedgerService.name);
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly ledger: TeamRecommendationDao,
    private readonly assessments: MemberAssessmentDao,
    private readonly store: TeamStoreService,
  ) {}

  onModuleInit(): void {
    this.bus.all().subscribe((event) => {
      if (this.concerns(event)) {
        void this.enqueue(event.runId, () => this.recordLive(event));
      }
    });
    void this.sweepQuietly();
  }

  /** Resolves once every copy queued so far has been written or logged as failed. */
  async settled(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  /**
   * Copy every card, Apply and mark of every team chat that still exists;
   * returns how many chats it read. Idempotent, so a launch with nothing new
   * changes nothing.
   */
  async sweep(): Promise<number> {
    const em = this.em.fork();
    const chats = await this.runDao.teamLedgerChats(em);
    let read = 0;
    for (const chat of chats) {
      const source = await this.sourceOf(chat, em);
      if (source === null) {
        continue;
      }
      const rows: LedgerRow[] = [
        ...(
          await this.itemDao.rowsOfKinds(
            chat.id,
            ['recommendations', 'recommendation_outcome'],
            undefined,
            em,
          )
        ).map((row) => ({
          seq: row.seq,
          kind: row.kind,
          role: row.role,
          createdAt: row.createdAt,
          payload: parseJsonColumn(row.payload),
        })),
        ...(await this.itemDao.userMessagesInOrder(chat.id, em)).map((row) => ({
          seq: row.seq,
          kind: 'message',
          role: 'user',
          createdAt: row.createdAt,
          payload: parseJsonColumn(row.payload),
        })),
      ].sort((a, b) => a.seq - b.seq);
      for (const row of rows) {
        await this.copy(source, row, null);
      }
      read += 1;
    }
    return read;
  }

  /** Whether a row is one the ledger copies, judged from the row alone. */
  private concerns(event: RunItemEvent): boolean {
    const { kind, role, payload } = event.item;
    return (
      kind === 'recommendations' ||
      kind === 'recommendation_outcome' ||
      (kind === 'message' && role === 'user' && applyIn(payload) !== null)
    );
  }

  /** The team a chat files about, its thread analysis's source run read when it needs one. */
  private async sourceOf(
    run: Pick<
      Run,
      'id' | 'analysisTeamSlug' | 'editsTeamSlug' | 'analysisSourceRunId'
    >,
    em: EntityManager,
  ): Promise<MemberAssessmentSource | null> {
    const analysed =
      run.analysisSourceRunId === null
        ? null
        : await this.runDao.getById(run.analysisSourceRunId, em);
    return assessmentSourceOf(run, analysed);
  }

  private async recordLive(event: RunItemEvent): Promise<void> {
    const em = this.em.fork();
    const run = await this.runDao.getById(event.runId, em);
    const source = run === null ? null : await this.sourceOf(run, em);
    if (source === null) {
      return;
    }
    await this.copy(
      source,
      {
        seq: event.item.seq,
        kind: event.item.kind,
        role: event.item.role,
        createdAt: new Date(event.item.createdAt),
        payload: event.item.payload,
      },
      event.item.kind === 'recommendations'
        ? await this.libraryVersion(source.slug)
        : null,
    );
  }

  private async copy(
    source: MemberAssessmentSource,
    row: LedgerRow,
    libraryVersion: string | null,
  ): Promise<void> {
    if (row.kind === 'recommendations') {
      const assessed = filedAssessmentsOf(source, row, libraryVersion);
      if (assessed === null) {
        this.logger.warn(
          `chat ${source.chatRunId} card ${row.seq} did not read as recommendations; not copied to the ledger`,
        );
        return;
      }
      if (source.chatKind !== 'thread') {
        await this.ledger.file(
          filedRecommendationsOf(
            { ...source, chatKind: source.chatKind },
            row,
            libraryVersion,
          ) ?? [],
        );
      }
      await this.assessments.file(assessed);
      return;
    }
    // A thread analysis's items stay with its source thread; only its
    // assessments of the team's members are the team's.
    if (source.chatKind === 'thread') {
      return;
    }
    if (row.kind === 'recommendation_outcome') {
      const marks = marksIn(row.payload);
      if (marks === null) {
        return;
      }
      for (const outcome of marks.outcomes) {
        await this.ledger.markOutcome(
          source.chatRunId,
          marks.cardSeq,
          {
            itemId: outcome.id,
            outcome: outcome.status,
            note: outcome.note ?? null,
          },
          { seq: row.seq, at: row.createdAt },
        );
      }
      return;
    }
    const apply = row.role === 'user' ? applyIn(row.payload) : null;
    if (apply !== null) {
      await this.ledger.markSelected(
        source.chatRunId,
        apply.cardSeq,
        apply.ids,
        row.createdAt,
      );
    }
  }

  /** The library's team version now, or null when the file cannot be read. */
  private async libraryVersion(slug: string): Promise<string | null> {
    try {
      return teamVersionOf((await this.store.get(slug)).team);
    } catch {
      return null;
    }
  }

  private enqueue(runId: string, work: () => Promise<void>): Promise<void> {
    const tail: Promise<void> = (this.queues.get(runId) ?? Promise.resolve())
      .then(work)
      .catch((err: unknown) => {
        this.logger.warn(
          `could not copy chat ${runId}'s recommendations to the ledger: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .then(() => {
        if (this.queues.get(runId) === tail) {
          this.queues.delete(runId);
        }
      });
    this.queues.set(runId, tail);
    return tail;
  }

  private async sweepQuietly(): Promise<void> {
    try {
      await this.sweep();
    } catch (err) {
      this.logger.warn(
        `recommendation ledger sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
