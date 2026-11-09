import {
  type ModelPriceRates,
  tokenCostUsd,
} from '../../agents/utils/model-prices';
import type { UsageEvent } from '../entity/usage-event.entity';
import type {
  SpendBreakdown,
  SpendFigures,
  TeamSpend,
  ThreadLedgerRow,
} from '../stats.types';
import { isPolledSpend } from './polled-spend';

/** A turn writing this much to the cache is re-writing a conversation, not adding to one. */
export const CACHE_HEAVY_WRITE_TOKENS = 100_000;
/** The recent window every figure is set beside. */
export const SPEND_RECENT_DAYS = 30;
/** How many of the largest cache writes an answer names; never a bound on a count. */
export const SPEND_LARGEST_WRITES = 10;

const DAY_MS = 86_400_000;

/** One `usage_events` row as the spend fold reads it. */
export type SpendLedgerRow = Pick<
  UsageEvent,
  | 'runId'
  | 'seq'
  | 'memberId'
  | 'agentKind'
  | 'model'
  | 'cwd'
  | 'occurredAt'
  | 'costUsd'
  | 'estimatedCostUsd'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheCreationTokens'
>;

/** The rates a turn was billed at, or null when its model has no list price. */
export type SpendRates = (
  agentKind: UsageEvent['agentKind'],
  model: string | null,
) => ModelPriceRates | null;

/** Where a turn's folder is filed. */
export interface SpendPlace {
  project: string | null;
  folder: string | null;
}

export interface TeamSpendInput {
  slug: string;
  /** Every thread row stamped with the team, a deleted run's included. */
  threads: readonly ThreadLedgerRow[];
  rows: readonly SpendLedgerRow[];
  analysedRunIds: readonly string[];
  now: Date;
  ratesOf: SpendRates;
  placeOf: (cwd: string | null) => SpendPlace;
}

const MONEY_PARTS = [
  'inputUsd',
  'cacheReadUsd',
  'cacheWriteUsd',
  'outputUsd',
  'notSplitUsd',
] as const;

type MoneyPart = (typeof MONEY_PARTS)[number];

function plus(total: number | null, value: number | null): number | null {
  return value === null ? total : (total ?? 0) + value;
}

function cents(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

/** A turn's bill by token class: its list price per class, scaled to what it was billed. */
function billByClass(
  row: SpendLedgerRow,
  rates: ModelPriceRates | null,
): Record<MoneyPart, number> {
  const bill = row.costUsd ?? 0;
  const parts = {
    inputUsd: 0,
    cacheReadUsd: 0,
    cacheWriteUsd: 0,
    outputUsd: 0,
    notSplitUsd: bill,
  };
  if (rates === null || isPolledSpend(row)) {
    return parts;
  }
  const none = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  };
  const inputUsd = tokenCostUsd(rates, {
    ...none,
    inputTokens: row.inputTokens,
  });
  const cacheReadUsd = tokenCostUsd(rates, {
    ...none,
    cacheReadTokens: row.cacheReadTokens,
  });
  const cacheWriteUsd = tokenCostUsd(rates, {
    ...none,
    cacheWriteTokens: row.cacheCreationTokens,
  });
  const outputUsd = tokenCostUsd(rates, {
    ...none,
    outputTokens: row.outputTokens,
  });
  const listUsd = inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd;
  if (listUsd <= 0) {
    return parts;
  }
  const scale = bill / listUsd;
  return {
    inputUsd: inputUsd * scale,
    cacheReadUsd: cacheReadUsd * scale,
    cacheWriteUsd: cacheWriteUsd * scale,
    outputUsd: outputUsd * scale,
    notSplitUsd: 0,
  };
}

function isHeavyWrite(row: SpendLedgerRow): boolean {
  return (row.cacheCreationTokens ?? 0) >= CACHE_HEAVY_WRITE_TOKENS;
}

/**
 * What a set of ledger rows cost, over every row handed in. Average per run
 * divides by the runs that reported or polled a cost, and a polled row is money
 * with no turn behind it.
 */
export function spendFiguresOf(
  rows: readonly SpendLedgerRow[],
  ratesOf: SpendRates,
): SpendFigures {
  const runs = new Set<string>();
  const pricedRuns = new Set<string>();
  let turns = 0;
  let costUsd: number | null = null;
  let estimatedCostUsd: number | null = null;
  const money: Record<MoneyPart, number> = {
    inputUsd: 0,
    cacheReadUsd: 0,
    cacheWriteUsd: 0,
    outputUsd: 0,
    notSplitUsd: 0,
  };
  let inputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheWriteTokens: number | null = null;
  let outputTokens: number | null = null;
  let cacheMissTurns = 0;
  let heavyWriteTurns = 0;
  for (const row of rows) {
    runs.add(row.runId);
    const polled = isPolledSpend(row);
    if (!polled) {
      turns += 1;
      inputTokens = plus(inputTokens, row.inputTokens);
      cacheReadTokens = plus(cacheReadTokens, row.cacheReadTokens);
      cacheWriteTokens = plus(cacheWriteTokens, row.cacheCreationTokens);
      outputTokens = plus(outputTokens, row.outputTokens);
      if (isHeavyWrite(row)) {
        heavyWriteTurns += 1;
        if ((row.cacheCreationTokens ?? 0) > (row.cacheReadTokens ?? 0)) {
          cacheMissTurns += 1;
        }
      }
    }
    if (row.costUsd === null || (polled && row.costUsd <= 0)) {
      continue;
    }
    pricedRuns.add(row.runId);
    costUsd = plus(costUsd, row.costUsd);
    estimatedCostUsd = plus(estimatedCostUsd, row.estimatedCostUsd);
    const parts = billByClass(
      row,
      polled ? null : ratesOf(row.agentKind, row.model),
    );
    for (const part of MONEY_PARTS) {
      money[part] += parts[part];
    }
  }
  const part = (key: MoneyPart): number | null =>
    costUsd === null ? null : cents(money[key]);
  return {
    runs: runs.size,
    pricedRuns: pricedRuns.size,
    turns,
    costUsd: cents(costUsd),
    avgCostPerRunUsd:
      costUsd === null || pricedRuns.size === 0
        ? null
        : cents(costUsd / pricedRuns.size),
    estimatedCostUsd: cents(estimatedCostUsd),
    inputUsd: part('inputUsd'),
    cacheReadUsd: part('cacheReadUsd'),
    cacheWriteUsd: part('cacheWriteUsd'),
    outputUsd: part('outputUsd'),
    notSplitUsd: part('notSplitUsd'),
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    cacheMissTurns,
    heavyWriteTurns,
  };
}

function earliestAt(rows: readonly SpendLedgerRow[]): string | null {
  return rows.reduce<string | null>((earliest, row) => {
    const at = row.occurredAt.toISOString();
    return earliest === null || at < earliest ? at : earliest;
  }, null);
}

function latestAt(rows: readonly SpendLedgerRow[]): string | null {
  return rows.reduce<string | null>((latest, row) => {
    const at = row.occurredAt.toISOString();
    return latest === null || at > latest ? at : latest;
  }, null);
}

/**
 * One team's spend over every ledger row of every run stamped with it, whatever
 * an analysis samples: the windows side by side, then by project, member and
 * model, each costliest first and none capped.
 */
export function foldTeamSpend(input: TeamSpendInput): TeamSpend {
  const { rows, ratesOf, now } = input;
  const asOf = now.toISOString();
  const recentFrom = new Date(now.getTime() - SPEND_RECENT_DAYS * DAY_MS);
  const recent = (row: SpendLedgerRow): boolean =>
    row.occurredAt.getTime() >= recentFrom.getTime();
  const analysed = new Set(input.analysedRunIds);
  const analysedRows = rows.filter((row) => analysed.has(row.runId));

  const breakdown = <Key extends object>(
    keyOf: (row: SpendLedgerRow) => string,
    labelOf: (row: SpendLedgerRow) => Key,
  ): (Key & SpendBreakdown)[] => {
    const groups = new Map<string, SpendLedgerRow[]>();
    for (const row of rows) {
      const key = keyOf(row);
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, [row]);
      } else {
        group.push(row);
      }
    }
    return [...groups.values()]
      .map((group) => {
        const inWindow = group.filter(recent);
        return {
          ...labelOf(group[0]!),
          all: spendFiguresOf(group, ratesOf),
          last30Days:
            inWindow.length === 0 ? null : spendFiguresOf(inWindow, ratesOf),
        };
      })
      .sort((a, b) => (b.all.costUsd ?? -1) - (a.all.costUsd ?? -1));
  };

  return {
    team: input.slug,
    asOf,
    method:
      "Costs are what each CLI reported or the account poll billed. The classes apportion each turn's bill by its tokens at the model's list rates, so a turn's parts sum to its bill; notSplitUsd is polled money and turns of a model with no list price. A cache miss is a turn that wrote at least 100000 tokens and wrote more than it read; a heavy write is a turn that wrote at least that much.",
    population: {
      covers:
        'Every run the ledgers hold stamped with this team: live, archived and deleted.',
      runs: input.threads.length,
      runsWithUsage: new Set(rows.map((row) => row.runId)).size,
      firstAt: earliestAt(rows),
      lastAt: latestAt(rows),
    },
    windows: [
      {
        window: 'all',
        covers: 'Every ledger row of those runs.',
        from: earliestAt(rows),
        to: asOf,
        ...spendFiguresOf(rows, ratesOf),
      },
      {
        window: 'last30Days',
        covers: `Those runs' ledger rows dated in the last ${SPEND_RECENT_DAYS} days; a run counts when it has a row in the window.`,
        from: recentFrom.toISOString(),
        to: asOf,
        ...spendFiguresOf(rows.filter(recent), ratesOf),
      },
      {
        window: 'analysedRuns',
        covers:
          "The runs this analysis reads, every ledger row of them as it stands now, not cut at the analysis's snapshot.",
        from: earliestAt(analysedRows),
        to: asOf,
        ...spendFiguresOf(analysedRows, ratesOf),
      },
    ],
    byProject: breakdown(
      (row) => JSON.stringify(input.placeOf(row.cwd)),
      (row) => input.placeOf(row.cwd),
    ),
    byMember: breakdown(
      (row) => row.memberId ?? '',
      (row) => ({ member: row.memberId }),
    ),
    byModel: breakdown(
      (row) => JSON.stringify([row.agentKind, row.model]),
      (row) => ({ agent: row.agentKind, model: row.model }),
    ),
    largestCacheWrites: rows
      .filter((row) => !isPolledSpend(row) && isHeavyWrite(row))
      .sort(
        (a, b) => (b.cacheCreationTokens ?? 0) - (a.cacheCreationTokens ?? 0),
      )
      .slice(0, SPEND_LARGEST_WRITES)
      .map((row) => ({
        runId: row.runId,
        seq: row.seq,
        member: row.memberId,
        model: row.model,
        at: row.occurredAt.toISOString(),
        cacheWriteTokens: row.cacheCreationTokens ?? 0,
        cacheReadTokens: row.cacheReadTokens,
        costUsd: row.costUsd,
        analysed: analysed.has(row.runId),
      })),
    next: "view=history sets these figures per team version, and view=runs per analysed run; view=item runId=… seq=… reads a turn of an analysed run.",
  };
}
