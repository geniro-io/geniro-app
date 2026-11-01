import { Injectable, Logger } from '@nestjs/common';

import { TeamChangeLogDao } from '../dao/team-change-log.dao';
import type {
  Team,
  TeamChangeLogRecord,
  TeamChangeSource,
} from '../teams.types';
import { teamVersionOf } from '../utils/team-version';

interface TeamChangeNote {
  slug: string;
  source: TeamChangeSource;
  /** The team as it stood before the write; null when the write created it. */
  before: Team | null;
  after: Team;
  summary?: string | null;
  reason?: string | null;
  userNote?: string | null;
  recommendationIds?: readonly string[];
  chatRunId?: string | null;
  cardSeq?: number | null;
  backup?: string | null;
}

/**
 * Writes the change log (`team_change_log`) and reads it back. Every writer
 * calls it AFTER the library file was written, so a log write that fails is
 * logged and never turns a saved change into a refusal.
 */
@Injectable()
export class TeamChangeLogService {
  private readonly logger = new Logger(TeamChangeLogService.name);

  constructor(private readonly dao: TeamChangeLogDao) {}

  async record(note: TeamChangeNote): Promise<void> {
    try {
      await this.dao.append({
        slug: note.slug,
        changedAt: new Date(),
        source: note.source,
        fromVersion: note.before === null ? null : teamVersionOf(note.before),
        toVersion: teamVersionOf(note.after),
        summary: blankToNull(note.summary),
        reason: blankToNull(note.reason),
        userNote: blankToNull(note.userNote),
        recommendationIds: [...new Set(note.recommendationIds ?? [])],
        chatRunId: note.chatRunId ?? null,
        cardSeq: note.cardSeq ?? null,
        backup: note.backup ?? null,
      });
    } catch (err) {
      this.logger.warn(
        `the change to team ${note.slug} (${note.source}) was saved but not logged: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The first team version run after the library converted this team from a
   * node graph: what it moved from is the graph's last recorded version.
   */
  async recordMigration(
    slug: string,
    fromVersion: string,
    toVersion: string,
  ): Promise<void> {
    try {
      await this.dao.append({
        slug,
        changedAt: new Date(),
        source: 'migration',
        fromVersion,
        toVersion,
        summary: MIGRATED_FROM_WORKFLOW,
        reason: null,
        userNote: null,
        recommendationIds: [],
        chatRunId: null,
        cardSeq: null,
        backup: null,
      });
    } catch (err) {
      this.logger.warn(
        `team ${slug}'s conversion from a node graph was not logged: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Every logged change of one team, oldest first. */
  entriesOf(slug: string): Promise<TeamChangeLogRecord[]> {
    return this.dao.entriesOf(slug);
  }
}

export const MIGRATED_FROM_WORKFLOW = 'migrated from workflow';

function blankToNull(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
