import { Injectable, Logger } from '@nestjs/common';

import { WorkflowChangeLogDao } from '../dao/workflow-change-log.dao';
import type {
  Workflow,
  WorkflowChangeLogRecord,
  WorkflowChangeSource,
} from '../graphs.types';
import { workflowVersionOf } from '../utils/workflow-version';

interface WorkflowChangeNote {
  slug: string;
  source: WorkflowChangeSource;
  /** The workflow as it stood before the write; null when the write created it. */
  before: Workflow | null;
  after: Workflow;
  summary?: string | null;
  reason?: string | null;
  userNote?: string | null;
  recommendationIds?: readonly string[];
  chatRunId?: string | null;
  cardSeq?: number | null;
  backup?: string | null;
}

/**
 * Writes the change log (`workflow_change_log`) and reads it back. Every writer
 * calls it AFTER the library file was written, so a log write that fails is
 * logged and never turns a saved change into a refusal.
 */
@Injectable()
export class WorkflowChangeLogService {
  private readonly logger = new Logger(WorkflowChangeLogService.name);

  constructor(private readonly dao: WorkflowChangeLogDao) {}

  async record(note: WorkflowChangeNote): Promise<void> {
    try {
      await this.dao.append({
        slug: note.slug,
        changedAt: new Date(),
        source: note.source,
        fromVersion:
          note.before === null ? null : workflowVersionOf(note.before),
        toVersion: workflowVersionOf(note.after),
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
        `the change to workflow ${note.slug} (${note.source}) was saved but not logged: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Every logged change of one workflow, oldest first. */
  entriesOf(slug: string): Promise<WorkflowChangeLogRecord[]> {
    return this.dao.entriesOf(slug);
  }
}

function blankToNull(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
