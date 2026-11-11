import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import type { MemoryCheckRecord } from '../../memory/dao/memory-review-finding.dao';
import {
  MEMORY_CHECK_PAIRS_MAX,
  type MemoryReviewCheckRequest,
  type MemoryReviewCheckResult,
  type MemoryReviewPairs,
  type MemoryReviewPairsQuery,
} from '../../memory/memory.types';
import { MemoryFindingsService } from '../../memory/services/memory-findings.service';
import { approxInstructionTokens } from '../utils/agent-instructions';
import {
  checkedText,
  checkPrompt,
  oneLine,
  quoteIn,
  readCheckAnswer,
} from '../utils/memory-check-prompt';
import { tokenCostUsd } from '../utils/model-prices';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { OneShotAskService } from './one-shot-ask.service';

/** What the prompt adds around one pair's two texts: its id and the A/B labels. */
const PAIR_OVERHEAD_CHARS = 16;
/** Roughly what an answer spends on one pair: a verdict, two quotes and a reason. */
const ANSWER_TOKENS_PER_PAIR = 120;

/**
 * The cleanup's check for duplicates and contradictions: the user's own CLI
 * judges likely pairs of entries one batch at a time, on the user's press.
 * Advice only — a finding stands only with a quote of each entry found in its
 * text, and the user decides what becomes of either.
 */
@Injectable()
export class MemoryCheckService {
  constructor(
    private readonly findings: MemoryFindingsService,
    private readonly asks: OneShotAskService,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  /** The pairs still to check, and what asking about all of them would take. */
  async pairs(query: MemoryReviewPairsQuery): Promise<MemoryReviewPairs> {
    const candidates = await this.findings.candidatePairs();
    const requests = Math.ceil(candidates.length / MEMORY_CHECK_PAIRS_MAX);
    const chars =
      requests * checkPrompt([]).length +
      candidates.reduce((sum, pair) => sum + pair.chars + PAIR_OVERHEAD_CHARS, 0);
    const inputTokens = approxInstructionTokens(chars);
    return {
      pairs: candidates.map(({ aId, bId }) => ({ aId, bId })),
      inputTokens,
      requests,
      costUsd: this.costOf(query, inputTokens, candidates.length),
      checkAgents: this.asks.agents(),
    };
  }

  /**
   * Ask about one batch and store every verdict the answer gave. A pair
   * changed or gone since it was listed, or one the answer skipped, is left
   * to a later check.
   */
  async check(
    request: MemoryReviewCheckRequest,
  ): Promise<MemoryReviewCheckResult> {
    const asked = await this.findings.checkable(request.pairs);
    if (asked.length === 0) {
      return { checked: 0, skipped: request.pairs.length, findings: [] };
    }
    const answer = await this.asks.ask(
      request,
      checkPrompt(asked.map(({ a, b }) => ({ a, b }))),
      { code: 'MEMORY_CHECK_UNAVAILABLE', task: 'check memory' },
    );
    const verdicts =
      answer === null ? null : readCheckAnswer(answer, asked.length);
    if (verdicts === null) {
      throw new BadRequestException(
        'MEMORY_CHECK_FAILED',
        answer === null
          ? `${request.agentKind} did not answer — check that it is installed and signed in`
          : `${request.agentKind} answered in a shape that could not be read`,
      );
    }
    const records = asked.flatMap((pair, index): MemoryCheckRecord[] => {
      const said = verdicts.get(index);
      if (said === undefined) {
        return [];
      }
      const judged = {
        memoryAId: pair.a.id,
        memoryBId: pair.b.id,
        hashA: pair.hashA,
        hashB: pair.hashB,
        agentKind: request.agentKind,
        model: request.model ?? null,
      };
      if (said.verdict === 'unrelated') {
        return [
          {
            ...judged,
            outcome: 'unrelated',
            quoteA: null,
            quoteB: null,
            reason: null,
          },
        ];
      }
      const quoted =
        quoteIn(said.quoteA, checkedText(pair.a)) &&
        quoteIn(said.quoteB, checkedText(pair.b));
      return [
        {
          ...judged,
          outcome: quoted ? said.verdict : 'unquoted',
          quoteA: quoted ? oneLine(said.quoteA) : null,
          quoteB: quoted ? oneLine(said.quoteB) : null,
          reason: said.reason,
        },
      ];
    });
    return {
      checked: records.length,
      skipped: request.pairs.length - records.length,
      findings: await this.findings.record(records),
    };
  }

  private costOf(
    query: MemoryReviewPairsQuery,
    inputTokens: number,
    pairCount: number,
  ): number | null {
    if (query.agentKind === undefined) {
      return null;
    }
    const rates = this.adapters
      .for(query.agentKind)
      .billingRatesOf(query.model ?? null);
    return rates === null
      ? null
      : tokenCostUsd(rates, {
          inputTokens,
          outputTokens: pairCount * ANSWER_TOKENS_PER_PAIR,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
  }
}
