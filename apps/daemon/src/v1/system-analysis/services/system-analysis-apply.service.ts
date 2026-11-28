import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import type {
  CardRecommendationItem,
  RecommendationMarks,
  RecommendationsPayload,
  SystemRecommendationApply,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { ChatService } from '../../agents/services/chat.service';
import { composeApplyMessage } from '../../agents/services/recommendations-apply.service';
import { appliesOf, readCard } from '../../agents/utils/recommendations-card';
import { ProjectDao } from '../../projects/dao/project.dao';
import type { Project } from '../../projects/entity/project.entity';
import { taskIdentifier } from '../../projects/utils/project-key';
import { TeamRecommendationDao } from '../../stats/dao/team-recommendation.dao';
import { TaskDao } from '../../tasks/dao/task.dao';
import { TasksService } from '../../tasks/services/tasks.service';
import { quietColumn } from '../../tasks/utils/armed-intake';
import type {
  SystemApply,
  SystemApplyOutcome,
  SystemApplyResult,
} from '../system-analysis.types';
import { SystemAnalysisEventBus } from './system-analysis-events.bus';

const KEPT_AS_REPORT = 'Kept as report';

/** Where a filed card's brief says it came from; the same item is never filed twice. */
export function systemSourceRef(
  runId: string,
  cardSeq: number,
  itemId: string,
): string {
  return `${runId}:${cardSeq}:${itemId}`;
}

/**
 * The report's button. Geniro files each selected geniro item as a board card
 * itself — no model turn — and for Implement right away asks the start drain
 * to start it; user and memory items still go to the analysis agent, which
 * edits files geniro never writes. Filing is idempotent by each card's source
 * reference, so a press cut short and pressed again files only what is
 * missing.
 */
@Injectable()
export class SystemAnalysisApplyService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
    private readonly projectDao: ProjectDao,
    private readonly taskDao: TaskDao,
    private readonly tasks: TasksService,
    private readonly ledger: TeamRecommendationDao,
    private readonly events: SystemAnalysisEventBus,
  ) {}

  async apply(runId: string, input: SystemApply): Promise<SystemApplyResult> {
    try {
      return await this.applyOnce(runId, input);
    } finally {
      this.events.publishChanged(runId);
    }
  }

  private async applyOnce(
    runId: string,
    input: SystemApply,
  ): Promise<SystemApplyResult> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${runId}`);
    }
    if (run.analysisPurpose !== 'system') {
      throw new ConflictException(
        'NOT_A_SYSTEM_ANALYSIS',
        'only a system analysis’s report is applied here',
      );
    }
    if (run.status === 'running' || run.status === 'pending') {
      throw new ConflictException(
        'RUN_BUSY',
        'the analysis is still working — apply once it has finished',
      );
    }
    let card: RecommendationsPayload;
    try {
      card = await readCard(this.itemDao, runId, input.cardSeq, em);
    } catch {
      throw new BadRequestException(
        'UNKNOWN_RECOMMENDATION',
        `there is no recommendations card at seq ${input.cardSeq}`,
      );
    }
    const byId = new Map(card.items.map((item) => [item.id, item]));
    const unknown = input.ids.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException(
        'UNKNOWN_RECOMMENDATION',
        `the card has no ${unknown.join(', ')}`,
      );
    }
    const applies = await appliesOf(this.itemDao, runId, em);
    if (applies.some((apply) => apply.cardSeq === input.cardSeq)) {
      throw new ConflictException(
        'ALREADY_APPLIED',
        `the card at seq ${input.cardSeq} has already been applied`,
      );
    }
    if (input.action === 'report') {
      return this.keep(runId, input, card);
    }
    const ids = [...new Set(input.ids)];
    if (ids.length === 0) {
      throw new BadRequestException(
        'UNKNOWN_RECOMMENDATION',
        'pick at least one item to file',
      );
    }
    const project = await this.projectOf(input, em);
    const selected = ids.map((id) => byId.get(id)!);
    const geniro = selected.filter((item) => item.target === 'geniro');
    const agentItems = selected.filter((item) => item.target !== 'geniro');
    const outcomes: SystemApplyOutcome[] = [];
    const filed: SystemRecommendationApply['filed'] = [];
    for (const item of geniro) {
      const outcome = await this.file(runId, input, item, project);
      outcomes.push(outcome);
      if (outcome.status === 'applied' && outcome.taskId !== undefined) {
        filed.push({
          id: item.id,
          taskId: outcome.taskId,
          identifier: outcome.identifier ?? null,
        });
      }
    }
    if (outcomes.length > 0) {
      await this.mark(runId, input.cardSeq, outcomes);
    }
    if (agentItems.length === 0 && filed.length === 0) {
      return { apply: null, outcomes };
    }
    const apply: SystemRecommendationApply = {
      cardSeq: input.cardSeq,
      ids,
      action: input.action,
      projectId: project.id,
      filed,
    };
    const row =
      agentItems.length > 0
        ? await this.chats.sendMessage(
            runId,
            composeApplyMessage(
              input.cardSeq,
              agentItems,
              card.items.filter((item) => !ids.includes(item.id)),
              geniro.length === 0 ? undefined : filedNote(input.action, filed),
            ),
            [],
            { clientMessageId: input.clientMessageId, apply },
          )
        : await this.chats.recordApply(
            runId,
            filedNote(input.action, filed),
            apply,
          );
    return { apply: row, outcomes };
  }

  private async projectOf(
    input: SystemApply,
    em: EntityManager,
  ): Promise<Project> {
    if (input.projectId === undefined) {
      throw new BadRequestException(
        'PROJECT_REQUIRED',
        'pick the board project the cards go to',
      );
    }
    const project = await this.projectDao.getById(input.projectId, em);
    if (project === null) {
      throw new NotFoundException(
        'PROJECT_NOT_FOUND',
        `no project: ${input.projectId}`,
      );
    }
    if (
      input.action === 'implement' &&
      project.agentKind === null &&
      project.teamSlug === null
    ) {
      throw new ConflictException(
        'PROJECT_NO_DEFAULT_TARGET',
        `project ${project.name} has no default agent or team to start a card on — set one, or create the cards only`,
      );
    }
    return project;
  }

  /** One geniro item filed as a card (or the card already filed for it), and started when asked. */
  private async file(
    runId: string,
    input: SystemApply,
    item: CardRecommendationItem,
    project: Project,
  ): Promise<SystemApplyOutcome> {
    const sourceRef = systemSourceRef(runId, input.cardSeq, item.id);
    try {
      const existing = await this.taskDao.findBySourceRef(
        'system_analysis',
        sourceRef,
      );
      const task =
        existing ??
        (await this.tasks.create({
          projectId: project.id,
          title: item.title,
          description: cardBrief(item),
          status: quietColumn(project),
          source: 'system_analysis',
          sourceRef,
        }));
      const identifier = taskIdentifier(project.taskKey, task.number);
      const start = input.action === 'implement' && task.runId === null;
      if (start) {
        const now = new Date();
        await this.taskDao.setStartRequest(task.id, {
          requestedAt: now,
          byRunId: runId,
          approvedAt: now,
          kind: 'analysis',
        });
      }
      await this.ledger.markApplied(runId, input.cardSeq, item.id, {
        taskId: task.id,
        applyAction: start ? 'start_requested' : 'filed',
      });
      return {
        id: item.id,
        status: 'applied',
        taskId: task.id,
        ...(identifier === null ? {} : { identifier }),
        reason: `${start ? 'filed to start' : 'filed'} ${identifier ?? task.id}`,
      };
    } catch (error) {
      return {
        id: item.id,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async keep(
    runId: string,
    input: SystemApply,
    card: RecommendationsPayload,
  ): Promise<SystemApplyResult> {
    const ids = card.items.map((item) => item.id);
    const outcomes: SystemApplyOutcome[] = ids.map((id) => ({
      id,
      status: 'skipped',
      reason: KEPT_AS_REPORT,
    }));
    if (outcomes.length > 0) {
      await this.mark(runId, input.cardSeq, outcomes);
    }
    for (const id of ids) {
      await this.ledger.markApplied(runId, input.cardSeq, id, {
        taskId: null,
        applyAction: 'kept',
      });
    }
    const row = await this.chats.recordApply(runId, KEPT_AS_REPORT, {
      cardSeq: input.cardSeq,
      ids,
      action: 'report',
      projectId: null,
      filed: [],
    });
    return { apply: row, outcomes };
  }

  private async mark(
    runId: string,
    cardSeq: number,
    outcomes: readonly SystemApplyOutcome[],
  ): Promise<void> {
    const marks: RecommendationMarks = {
      cardSeq,
      outcomes: outcomes.map((outcome) => ({
        id: outcome.id,
        status: outcome.status,
        ...(outcome.reason === undefined
          ? {}
          : { note: outcome.reason.slice(0, 600) }),
      })),
    };
    await this.chats.recordAnalysisRow(runId, 'recommendation_outcome', marks);
  }
}

/** A filed card's brief: the change, why, the evidence, and the flags it answers. */
export function cardBrief(item: CardRecommendationItem): string {
  const evidence = item.evidence.map(
    (cited) =>
      `- ${cited.runId === undefined ? '' : `run ${cited.runId} `}seq ${cited.seq}: “${cited.quote}”`,
  );
  return [
    `Component: ${item.location}`,
    '',
    item.change,
    '',
    '## Why',
    item.rootCause,
    ...(evidence.length === 0 ? [] : ['', '## Evidence', ...evidence]),
    ...(item.addressesFlags === undefined || item.addressesFlags.length === 0
      ? []
      : ['', `Flags it answers: ${item.addressesFlags.join(', ')}`]),
    ...toolDataLines(item.tool),
    '',
    'Filed by a system analysis.',
  ].join('\n');
}

/** The verdict and the counters' figures the daemon froze for a tool item. */
function toolDataLines(tool: CardRecommendationItem['tool']): string[] {
  if (tool === undefined) {
    return [];
  }
  const head = `Verdict: ${tool.verdict} — ${tool.subjectKind} ${tool.subject}${tool.source === '' ? '' : ` (${tool.source})`}`;
  const figures = tool.figures;
  if (figures === undefined) {
    return ['', head];
  }
  const line = (label: string, value: string | number | null): string[] =>
    value === null ? [] : [`- ${label}: ${value}`];
  return [
    '',
    `## Data (from the counters as of ${figures.asOf})`,
    head,
    ...line('Calls', figures.calls),
    ...line('Of them by sub-agents', figures.subagent),
    ...line('Errors', figures.errors),
    ...line('Refused', figures.refused),
    ...line('Average time, ms', figures.avgMs),
    ...line('Average result size, characters', figures.avgChars),
    ...line('Last call', figures.lastAt),
    ...line('Known since', figures.knownSince),
    ...line('Offered in sessions', figures.offered),
  ];
}

function filedNote(
  action: SystemApply['action'],
  filed: SystemRecommendationApply['filed'],
): string {
  const verb =
    action === 'implement' ? 'Create cards and start' : 'Create cards';
  const keys = filed.map(
    (entry) => `${entry.id} → ${entry.identifier ?? entry.taskId}`,
  );
  return keys.length === 0 ? verb : `${verb}: ${keys.join(', ')}`;
}
