import { Injectable } from '@nestjs/common';

import type { Run } from '../../runs/entity/run.entity';
import type {
  PullRequestDoneMark,
  PullRequestLifecycleRead,
  RunPullRequestOutcomes,
} from '../chat.types';
import { ChatSearchIndexDao } from '../dao/chat-search-index.dao';
import {
  pullRequestOutcomeKey,
  readRunPullRequests,
} from '../utils/pull-request-capture';
import {
  DONE_MARK_QUERY,
  doneMarksOf,
  MAX_DONE_MARK_ROWS,
} from '../utils/pull-request-done-marks';
import { PullRequestLifecycleService } from './pull-request-lifecycle.service';

/** One pull request of a run, with the rows that said it was done and its life on GitHub. */
export interface RunPullRequestLife {
  key: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  marks: PullRequestDoneMark[];
  read: PullRequestLifecycleRead;
}

export interface RunAtSnapshot {
  run: Pick<Run, 'id' | 'pullRequests' | 'touchedPullRequests'>;
  snapshotSeq: number;
  outcomes: readonly RunPullRequestOutcomes[];
}

/**
 * The pull requests an analysed run itself named — opened, touched, or
 * recorded an outcome for, up to its snapshot — each with its done marks and
 * its GitHub life, read for every run of one analysis read in one budget. No
 * other pull request is ever asked about.
 */
@Injectable()
export class PullRequestAfterDoneService {
  constructor(
    private readonly search: ChatSearchIndexDao,
    private readonly lifecycles: PullRequestLifecycleService,
  ) {}

  /**
   * A pull request the run's messages link to without the run having opened,
   * touched or recorded it — named by number, with an owner and repository
   * or without — read the same way. Null when no message links to it, or
   * links to that number in more than one repository.
   */
  async mentioned(
    at: RunAtSnapshot,
    named: { owner?: string; repo?: string; number: number },
  ): Promise<RunPullRequestLife | null> {
    const links = new RegExp(
      `github\\.com/([\\w.-]+)/([\\w.-]+)/pull/${named.number}(?!\\d)`,
      'gi',
    );
    const repositories = new Map<string, { owner: string; repo: string }>();
    for (const row of await this.search.runRowsMatching(
      at.run.id,
      `"pull ${named.number}"`,
      at.snapshotSeq,
      MAX_DONE_MARK_ROWS,
    )) {
      for (const [, owner, repo] of row.text.matchAll(links)) {
        const key = `${owner}/${repo}`.toLowerCase();
        const asked =
          named.owner === undefined || named.repo === undefined
            ? null
            : `${named.owner}/${named.repo}`.toLowerCase();
        if (asked === null || asked === key) {
          repositories.set(key, { owner: owner!, repo: repo! });
        }
      }
    }
    const [repository, ...others] = repositories.values();
    if (repository === undefined || others.length > 0) {
      return null;
    }
    const ref = { ...repository, number: named.number };
    const key = pullRequestOutcomeKey(ref);
    const rows = await this.search.runRowsMatching(
      at.run.id,
      DONE_MARK_QUERY,
      at.snapshotSeq,
      MAX_DONE_MARK_ROWS,
    );
    const reads = await this.lifecycles.readMany([ref]);
    return {
      key,
      ...ref,
      url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      marks: doneMarksOf(ref, undefined, rows),
      read: reads.get(key) ?? { unavailable: 'read-budget-spent' },
    };
  }

  /** `only`, when given, asks GitHub about that pull request alone; the rest answer `read-budget-spent` unless cached. */
  async forRuns(
    runs: readonly RunAtSnapshot[],
    only?: (key: string) => boolean,
  ): Promise<Map<string, RunPullRequestLife[]>> {
    const perRun: {
      runId: string;
      entries: Omit<RunPullRequestLife, 'read'>[];
    }[] = [];
    for (const { run, snapshotSeq, outcomes } of runs) {
      const refs = new Map<
        string,
        { owner: string; repo: string; number: number; url: string }
      >();
      for (const pullRequest of [
        ...readRunPullRequests(run.pullRequests),
        ...readRunPullRequests(run.touchedPullRequests),
      ]) {
        if (pullRequest.seq <= snapshotSeq) {
          refs.set(pullRequestOutcomeKey(pullRequest), pullRequest);
        }
      }
      const byKey = new Map(
        outcomes.map((recorded) => [pullRequestOutcomeKey(recorded), recorded]),
      );
      for (const [key, recorded] of byKey) {
        if (!refs.has(key)) {
          refs.set(key, recorded);
        }
      }
      const rows =
        refs.size === 0
          ? []
          : await this.search.runRowsMatching(
              run.id,
              DONE_MARK_QUERY,
              snapshotSeq,
              MAX_DONE_MARK_ROWS,
            );
      perRun.push({
        runId: run.id,
        entries: [...refs].map(([key, ref]) => ({
          key,
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
          url: ref.url,
          marks: doneMarksOf(ref, byKey.get(key), rows),
        })),
      });
    }
    const reads = await this.lifecycles.readMany(
      perRun
        .flatMap(({ entries }) => entries)
        .filter((entry) => only === undefined || only(entry.key)),
    );
    return new Map(
      perRun.map(({ runId, entries }) => [
        runId,
        entries.map((entry) => ({
          ...entry,
          read: reads.get(entry.key) ?? { unavailable: 'read-budget-spent' },
        })),
      ]),
    );
  }
}
