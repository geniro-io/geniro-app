import { Injectable } from '@nestjs/common';

import type { RunProjectRef } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { runProjectRefOf } from '../../agents/utils/run-project-ref';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import { TaskDao } from '../../tasks/dao/task.dao';
import type {
  CommandCenterTaskRef,
  CommandCenterTimeline,
  CommandCenterTimelineEvent,
} from '../command-center.types';
import { CommandCenterRosterDao } from '../dao/command-center-roster.dao';
import { CommandCenterTimelineDao } from '../dao/command-center-timeline.dao';
import { cardsByRun, taskRefOf } from '../utils/task-ref';
import {
  approvalEvent,
  errorLineOf,
  failedEvent,
  managerMessageEvent,
  outcomeEvent,
  pullRequestEvent,
  stageEvent,
  startRequestEvent,
  threadMessageEvent,
  threadStartedEvent,
  type TimelineCandidate,
  userMessageEvent,
} from '../utils/timeline-events';
import { pageOf } from '../utils/timeline-page';
import { CommandCenterService } from './command-center.service';

const FAR_FUTURE = new Date(8.64e15);
const UNTITLED_THREAD = 'Untitled thread';

interface TimelineThread {
  title: string | null;
  task: CommandCenterTaskRef | null;
  project: RunProjectRef | null;
}

/**
 * The command center's timeline: what the manager said and was told, and what
 * its threads did, merged newest first. Its threads are every run on the
 * manager's roster, left ones included, and every active thread on the board.
 */
@Injectable()
export class CommandCenterTimelineService {
  constructor(
    private readonly board: CommandCenterService,
    private readonly roster: CommandCenterRosterDao,
    private readonly items: ItemDao,
    private readonly timeline: CommandCenterTimelineDao,
    private readonly tasks: TaskDao,
    private readonly projects: ProjectScopeService,
  ) {}

  async page(
    before: Date | null,
    limit: number,
  ): Promise<CommandCenterTimeline> {
    const managerRunId = await this.board.managerRunId();
    if (managerRunId === null) {
      return { events: [], nextBefore: null };
    }
    const [active, rosterRows] = await Promise.all([
      this.board.activeThreads(),
      this.roster.listOf(managerRunId),
    ]);
    const threadRunIds = [
      ...new Set([
        ...rosterRows.map((row) => row.threadRunId),
        ...active.runs.map((run) => run.id),
      ]),
    ];
    const cutoff = before ?? FAR_FUTURE;
    const now = Date.now();

    const [
      userMessages,
      managerMessages,
      threadMessages,
      threadRuns,
      startRequests,
      pullRequests,
      approvals,
      stages,
      outcomes,
      failed,
    ] = await Promise.all([
      this.timeline.userMessages(managerRunId, cutoff, limit),
      this.timeline.managerMessages(managerRunId, threadRunIds, cutoff, limit),
      this.timeline.threadMessages(managerRunId, threadRunIds, cutoff, limit),
      this.timeline.threadStarts(threadRunIds, cutoff, limit),
      this.timeline.startRequests(managerRunId, cutoff, limit),
      this.timeline.pullRequests(threadRunIds, cutoff, limit),
      this.timeline.approvals(threadRunIds, cutoff, limit),
      this.timeline.stages(threadRunIds, cutoff, limit),
      this.timeline.outcomes(threadRunIds, cutoff, limit),
      this.failedCandidates(threadRunIds, cutoff),
    ]);

    const candidates: TimelineCandidate[] = [
      ...userMessages.map(userMessageEvent),
      ...managerMessages.map((row) => managerMessageEvent(row, now)),
      ...threadMessages.map(threadMessageEvent),
      ...threadRuns.map(threadStartedEvent),
      ...startRequests.flatMap((task) =>
        task.startRequestedAt === null
          ? []
          : [startRequestEvent(task, task.startRequestedAt)],
      ),
      ...pullRequests.map(pullRequestEvent),
      ...approvals.map(approvalEvent),
      ...stages.map(stageEvent),
      ...outcomes.map(outcomeEvent),
      ...failed,
    ];

    const page = pageOf(candidates, limit);
    const threads = await this.threadsOf(
      page.rows.flatMap((row) =>
        row.threadRunId === null ? [] : [row.threadRunId],
      ),
    );

    return {
      events: page.rows.map((row): CommandCenterTimelineEvent => {
        const threadRunId = row.threadRunId;
        const thread =
          threadRunId === null ? undefined : threads.get(threadRunId);
        return {
          id: row.id,
          at: row.at.toISOString(),
          kind: row.kind,
          threadRunId,
          threadTitle:
            threadRunId === null
              ? null
              : (thread?.title ?? row.fallbackTitle ?? UNTITLED_THREAD),
          task: thread?.task ?? null,
          project: thread?.project ?? null,
          text: row.text,
          detail: row.detail,
          awaitingReply: row.awaitingReply,
        };
      }),
      nextBefore: page.nextBefore?.toISOString() ?? null,
    };
  }

  private async failedCandidates(
    threadRunIds: readonly string[],
    cutoff: Date,
  ): Promise<TimelineCandidate[]> {
    const runs = await this.timeline.failedRuns(threadRunIds);
    const runIds = runs.map((run) => run.id);
    const [activity, errors] = await Promise.all([
      this.items.latestItemAtPerRun(runIds),
      this.timeline.errorItems(runIds),
    ]);
    const newestError = new Map<string, string | null>();
    for (const row of errors) {
      if (!newestError.has(row.run_id)) {
        newestError.set(row.run_id, errorLineOf(row));
      }
    }
    return runs.flatMap((run) => {
      const at = activity.get(run.id) ?? run.updatedAt;
      return at.getTime() < cutoff.getTime()
        ? [failedEvent(run, at, newestError.get(run.id) ?? null)]
        : [];
    });
  }

  private async threadsOf(
    runIds: string[],
  ): Promise<Map<string, TimelineThread>> {
    const ids = [...new Set(runIds)];
    const runs = await this.timeline.threadRefsOf(ids);
    const [cards, projectNames] = await Promise.all([
      this.tasks.listByRunIds(ids),
      this.projects.liveNamesOf(runs.map((run) => run.projectId)),
    ]);
    const cardOf = cardsByRun(cards);
    return new Map(
      runs.map((run): [string, TimelineThread] => {
        const projectName =
          run.projectId === null
            ? null
            : (projectNames.get(run.projectId) ?? null);
        return [
          run.id,
          {
            title: run.title,
            task: taskRefOf(run, cardOf.get(run.id) ?? null),
            project: runProjectRefOf(run.projectId, projectName),
          },
        ];
      }),
    );
  }
}
