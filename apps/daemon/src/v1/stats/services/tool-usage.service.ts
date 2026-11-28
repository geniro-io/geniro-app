import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { ProjectDao } from '../../projects/dao/project.dao';
import { UsageCounterDao } from '../dao/usage-counter.dao';
import type {
  ToolUsageListWire,
  ToolUsageSubjectWire,
  UsageSubjectKind,
} from '../stats.types';
import { foldSubject, foldToolUsage } from '../utils/usage-counter-fold';
import { UsageCounterService } from './usage-counter.service';
import { UsageCounterBackfillService } from './usage-counter-backfill.service';
import { UsageRegistryService } from './usage-registry.service';

/**
 * The usage counters as Settings → System analysis and the system digest read
 * them: every counter row, never a page of them, written up to now first.
 */
@Injectable()
export class ToolUsageService {
  constructor(
    private readonly em: EntityManager,
    private readonly dao: UsageCounterDao,
    private readonly counters: UsageCounterService,
    private readonly registry: UsageRegistryService,
    private readonly backfill: UsageCounterBackfillService,
    private readonly projects: ProjectDao,
  ) {}

  async list(): Promise<ToolUsageListWire> {
    await this.counters.flush();
    const em = this.em.fork();
    const fold = foldToolUsage({
      rows: await this.dao.rows(em),
      subjects: await this.dao.subjects(em),
      bootAt: this.registry.bootAt,
      now: Date.now(),
    });
    const liveSince = this.backfill.cutoff;
    const since =
      fold.oldestUse === null
        ? liveSince
        : liveSince === null
          ? fold.oldestUse
          : Math.min(fold.oldestUse, liveSince);
    return {
      countingSince: since === null ? null : new Date(since).toISOString(),
      liveSince: liveSince === null ? null : new Date(liveSince).toISOString(),
      rows: fold.rows,
      neverCalled: fold.neverCalled,
    };
  }

  async subject(subject: {
    subjectKind: UsageSubjectKind;
    subject: string;
    source: string;
  }): Promise<ToolUsageSubjectWire> {
    await this.counters.flush();
    const em = this.em.fork();
    const rows = await this.dao.rowsOfSubject(subject, em);
    const subjects = await this.dao.subjects(em);
    const projects = await this.projects.listRefs(em);
    return foldSubject({
      subject,
      rows,
      known: subjects.find(
        (row) =>
          row.subjectKind === subject.subjectKind &&
          row.subject === subject.subject &&
          row.source === subject.source,
      ),
      bootAt: this.registry.bootAt,
      now: Date.now(),
      projectNames: new Map(
        projects.map((project) => [project.id, project.name]),
      ),
    });
  }
}
