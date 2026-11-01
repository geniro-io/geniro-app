import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import {
  HOST_QUESTION_TOOL,
  type RunOutcomeEntry,
  type RunPullRequestOutcomes,
  type SeqRange,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { asRecord, asString, parseJsonColumn } from '../utils/json-util';
import { pullRequestOutcomeKey } from '../utils/pull-request-capture';
import { parseRunOutcomePayload } from '../utils/run-outcome-payload';
import { outcomeHistoryFigures } from '../utils/run-outcomes';
import { AgentAdapterRegistry } from './agent-adapter.registry';

/**
 * How many questions one question card put to the user: its normalized
 * `questions` when the row carries them, else the CLI's own `input.questions`
 * (rows written before the normalized field), else one.
 */
function questionsOnCard(payload: Record<string, unknown>): number {
  if (Array.isArray(payload.questions) && payload.questions.length > 0) {
    return payload.questions.length;
  }
  const input = asRecord(payload.input);
  if (Array.isArray(input?.questions) && input.questions.length > 0) {
    return input.questions.length;
  }
  return 1;
}

/** What {@link RunOutcomeHistoryService.read} answers. */
export interface RunOutcomeHistory {
  pullRequests: RunPullRequestOutcomes[];
  /** Every question put to the user on the run, by any of its agents. */
  questionsAsked: number;
}

interface QuestionCard {
  seq: number;
  questions: number;
}

/**
 * A run's recorded pull request outcomes read whole from its `run_outcome`
 * rows, and the questions put to the user around them — counted from the
 * question cards, never taken from an agent or a stored payload, so the
 * broker, the stats ledger, the analysis reader and the panel route all count
 * alike.
 */
@Injectable()
export class RunOutcomeHistoryService {
  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  /**
   * Every pull request the run recorded an outcome for, the most recently
   * recorded first, each one's outcomes newest first, and every question put
   * to the user on the run — all through `throughSeq` when given. A row that
   * does not read as an outcome is left out.
   */
  async read(
    runId: string,
    throughSeq?: number,
    txEm?: EntityManager,
  ): Promise<RunOutcomeHistory> {
    const em = txEm ?? this.em.fork();
    const range =
      throughSeq === undefined ? undefined : { before: throughSeq + 1 };
    const rows = await this.itemDao.rowsOfKinds(
      runId,
      ['run_outcome'],
      range,
      em,
    );
    const cards = await this.questionCards(runId, range, em);
    const byPullRequest = new Map<
      string,
      {
        owner: string;
        repo: string;
        number: number;
        url: string;
        entries: { entry: RunOutcomeEntry; at: Date }[];
      }
    >();
    for (const row of rows) {
      const parsed = parseRunOutcomePayload(parseJsonColumn(row.payload));
      if (!parsed.success) {
        continue;
      }
      const payload = parsed.data;
      const key = pullRequestOutcomeKey({
        owner: payload.prOwner,
        repo: payload.prRepo,
        number: payload.prNumber,
      });
      const group = byPullRequest.get(key) ?? {
        owner: payload.prOwner,
        repo: payload.prRepo,
        number: payload.prNumber,
        url: payload.prUrl,
        entries: [],
      };
      group.url = payload.prUrl;
      group.entries.push({
        at: row.createdAt,
        entry: {
          seq: row.seq,
          at: row.createdAt.toISOString(),
          draft: payload.draft,
          reviewRounds: payload.reviewRounds,
          acceptance: payload.acceptance,
          questionsAsked: askedBefore(cards, row.seq),
          summary: payload.summary?.trim() || null,
          nodeId: payload.nodeId,
        },
      });
      byPullRequest.set(key, group);
    }
    const pullRequests = [...byPullRequest.values()]
      .map((group): RunPullRequestOutcomes => ({
        owner: group.owner,
        repo: group.repo,
        number: group.number,
        url: group.url,
        ...outcomeHistoryFigures(
          group.entries.map(({ entry, at }) => ({
            seq: entry.seq,
            at,
            acceptance: entry.acceptance,
          })),
        ),
        outcomes: group.entries
          .map(({ entry }) => entry)
          .sort((a, b) => b.seq - a.seq),
      }))
      .sort((a, b) => (b.outcomes[0]?.seq ?? 0) - (a.outcomes[0]?.seq ?? 0));
    return { pullRequests, questionsAsked: askedBefore(cards, undefined) };
  }

  private async questionCards(
    runId: string,
    range: SeqRange | undefined,
    em: EntityManager,
  ): Promise<QuestionCard[]> {
    const questionTools = new Set<string>([HOST_QUESTION_TOOL]);
    for (const adapter of this.adapters.all().values()) {
      const name = adapter.getConfig().questionToolName;
      if (name !== null) {
        questionTools.add(name);
      }
    }
    const cards: QuestionCard[] = [];
    for (const row of await this.itemDao.rowsOfKinds(
      runId,
      ['approval_request'],
      range,
      em,
    )) {
      const payload = asRecord(parseJsonColumn(row.payload));
      const toolName = asString(payload?.toolName);
      if (
        payload !== null &&
        toolName !== null &&
        questionTools.has(toolName)
      ) {
        cards.push({ seq: row.seq, questions: questionsOnCard(payload) });
      }
    }
    return cards;
  }
}

function askedBefore(
  cards: readonly QuestionCard[],
  beforeSeq: number | undefined,
): number {
  return cards.reduce(
    (total, card) =>
      beforeSeq === undefined || card.seq < beforeSeq
        ? total + card.questions
        : total,
    0,
  );
}
