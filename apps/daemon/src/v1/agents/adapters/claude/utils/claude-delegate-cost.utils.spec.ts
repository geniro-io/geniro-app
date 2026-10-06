import { describe, expect, it } from 'vitest';

import { catalogClaudePrices } from './__tests__/claude-list-prices';
import {
  ClaudeDelegateCostLedger,
  listCostUsd,
} from './claude-delegate-cost.utils';

/**
 * The 2.1.251 probe this whole derivation was built from, verbatim.
 *
 * One turn, one delegate told to answer `OK` and use no tools. The delegate's
 * own breakdown is the `tool_use_result` riding the `user` line that closed its
 * `Task` call; the roll-up is the turn's `result` line. Together they are the
 * only two facts the price is made of, so the numbers are kept here exactly as
 * the CLI printed them.
 */
const PROBE_DELEGATE = {
  model: 'claude-opus-5[1m]',
  inputTokens: 2,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheCreationTokens: 29_382,
};

/** The probe's own `session_id` — every line of one process carries it. */
const SESSION = 'e8ff1386-3c9b-4aa3-b507-c82715de4346';

const PROBE_RESULT = {
  total_cost_usd: 0.44389499999999993,
  modelUsage: {
    'claude-opus-5[1m]': {
      inputTokens: 6,
      outputTokens: 313,
      cacheReadInputTokens: 59_805,
      cacheCreationInputTokens: 51_632,
      costUSD: 0.44389499999999993,
      contextWindow: 1_000_000,
      canonicalModel: 'claude-opus-5',
      costBasis: 'list',
    },
  },
};

/** The catalog's anthropic prices, through the daemon's own parser. */
const PRICES = catalogClaudePrices();

describe('ClaudeDelegateCostLedger', () => {
  it('prices the probed delegate inside the band its token mix has to fall in', () => {
    const ledger = new ClaudeDelegateCostLedger(PRICES);
    ledger.record(SESSION, 'toolu_016irjy3GNmGTa2RzaFCy6HM', PROBE_DELEGATE);

    const [priced, ...rest] = ledger.settle(SESSION, PROBE_RESULT);

    expect(rest).toEqual([]);
    expect(priced?.id).toBe('toolu_016irjy3GNmGTa2RzaFCy6HM');
    // List price for this delegate's own breakdown is $0.18375, and the turn
    // billed 1.2315x list — so the delegate cost about 22.6 cents.
    expect(priced?.costUsd).toBeCloseTo(0.2263, 4);
  });

  it('beats a proportional split, which is what it exists to replace', () => {
    // The naive alternative: the turn's blended per-token rate times the
    // delegate's token count. It underprices a cache-write-heavy delegate
    // against a cache-read-heavy turn by nearly half, because the two kinds
    // bill 12.5x apart — the defect this whole file is the fix for.
    const turnTokens = 6 + 313 + 59_805 + 51_632;
    const proportional =
      (PROBE_RESULT.total_cost_usd / turnTokens) * (2 + 4 + 0 + 29_382);
    const ledger = new ClaudeDelegateCostLedger(PRICES);
    ledger.record(SESSION, 'toolu_a', PROBE_DELEGATE);

    const [priced] = ledger.settle(SESSION, PROBE_RESULT);

    expect(proportional).toBeCloseTo(0.1167, 4);
    expect(priced?.costUsd).toBeGreaterThan(proportional * 1.5);
  });

  it('shows no figure for a model the catalog does not list', () => {
    const ledger = new ClaudeDelegateCostLedger(PRICES);
    ledger.record(SESSION, 'toolu_a', {
      ...PROBE_DELEGATE,
      model: 'claude-something-nobody-shipped-yet',
    });

    // Not a zero, and not the pooled factor applied to nothing: the delegate
    // simply carries no cost, which the header renders as tokens alone.
    expect(ledger.settle(SESSION, PROBE_RESULT)).toEqual([]);
  });

  it('shows no figure when the CLI named no model for the delegate', () => {
    const ledger = new ClaudeDelegateCostLedger(PRICES);
    ledger.record(SESSION, 'toolu_a', { ...PROBE_DELEGATE, model: null });

    expect(ledger.settle(SESSION, PROBE_RESULT)).toEqual([]);
  });

  it('refuses a calibration factor outside the believable band', () => {
    const ledger = new ClaudeDelegateCostLedger(PRICES);
    ledger.record(SESSION, 'toolu_a', PROBE_DELEGATE);

    // A turn charged 30x what the table says its tokens cost is not a turn
    // whose factor can correct the table — it is a table naming the wrong
    // model family, and correcting from it would multiply the delegate's price
    // by the same 30.
    expect(
      ledger.settle(SESSION, {
        modelUsage: {
          'claude-opus-5[1m]': {
            ...PROBE_RESULT.modelUsage['claude-opus-5[1m]'],
            costUSD: 30,
          },
        },
      }),
    ).toEqual([]);
  });

  it('prices a delegate off ITS OWN model, not the turn’s dominant one', () => {
    const ledger = new ClaudeDelegateCostLedger(PRICES);
    // A haiku delegate beside an opus main thread — the case a single pooled
    // factor gets wrong, since the two models bill 5x apart.
    ledger.record(SESSION, 'toolu_haiku', {
      model: 'claude-haiku-4-5',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    const [priced] = ledger.settle(SESSION, {
      modelUsage: {
        ...PROBE_RESULT.modelUsage,
        // Billed exactly at list, so this model's own factor is 1.0 and the
        // delegate's million input tokens must come out at haiku's $1/M.
        'claude-haiku-4-5': {
          inputTokens: 2_000_000,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 2,
        },
      },
    });

    expect(priced?.costUsd).toBeCloseTo(1, 6);
  });

  it('falls back to the pooled factor for a model the roll-up does not name', () => {
    const ledger = new ClaudeDelegateCostLedger(PRICES);
    ledger.record(SESSION, 'toolu_a', {
      ...PROBE_DELEGATE,
      model: 'claude-sonnet-5',
    });

    const [priced] = ledger.settle(SESSION, PROBE_RESULT);

    // Priced at sonnet's own list rate ($2/M input), lifted by the only factor
    // this turn measured. Nothing else could serve: the alternative is showing
    // no cost for a delegate whose model simply did not make the roll-up.
    const sonnetList = (2 * 2 + 4 * 10 + 29_382 * 2 * 1.25) / 1_000_000;
    expect(priced?.costUsd).toBeCloseTo(sonnetList * 1.2314767, 6);
  });

  it('empties the pending set on settle, so a delegate is priced exactly once', () => {
    const ledger = new ClaudeDelegateCostLedger(PRICES);
    ledger.record(SESSION, 'toolu_a', PROBE_DELEGATE);

    expect(ledger.settle(SESSION, PROBE_RESULT)).toHaveLength(1);
    // The second turn of the same session must not re-price the first turn's
    // delegate — nor price it against a calibration this delegate never ran
    // under, which is what carrying it forward would mean.
    expect(ledger.settle(SESSION, PROBE_RESULT)).toEqual([]);
  });

  it('drops a turn’s delegates even when the turn priced none of them', () => {
    const ledger = new ClaudeDelegateCostLedger(PRICES);
    ledger.record(SESSION, 'toolu_a', PROBE_DELEGATE);

    // A `result` with no roll-up at all: nothing to calibrate from, so no
    // figure — but the delegate is still this turn's and must not survive into
    // the next turn's accounting.
    expect(ledger.settle(SESSION, {})).toEqual([]);
    expect(ledger.settle(SESSION, PROBE_RESULT)).toEqual([]);
  });

  it('re-recording one delegate keeps the latest breakdown, not both', () => {
    const ledger = new ClaudeDelegateCostLedger(PRICES);
    ledger.record(SESSION, 'toolu_a', PROBE_DELEGATE);
    ledger.record(SESSION, 'toolu_a', {
      ...PROBE_DELEGATE,
      cacheCreationTokens: 0,
    });

    const priced = ledger.settle(SESSION, PROBE_RESULT);

    expect(priced).toHaveLength(1);
    // The cache writes were the whole bill; without them the delegate is worth
    // a hundredth of a cent, which is what the second record said.
    expect(priced[0]?.costUsd).toBeLessThan(0.001);
  });

  it('never lets one session’s result price ANOTHER session’s delegate', () => {
    // One ledger serves every process an adapter drives, and graph fan-out runs
    // several at once. Keyed by call id alone, session B's `result` took A's
    // pending delegate — priced it with B's calibration, announced its cost in
    // B's stream — and left A's own `result` nothing to price.
    const ledger = new ClaudeDelegateCostLedger(PRICES);
    ledger.record('session-a', 'toolu_a', PROBE_DELEGATE);

    expect(ledger.settle('session-b', PROBE_RESULT)).toEqual([]);
    expect(ledger.takeSettledUsd('session-b')).toBe(0);

    const [priced] = ledger.settle('session-a', PROBE_RESULT);
    expect(priced?.id).toBe('toolu_a');
    expect(priced?.costUsd).toBeCloseTo(0.2263, 4);
  });

  it('hands the settled delegate spend only to the session that settled it', () => {
    const ledger = new ClaudeDelegateCostLedger(PRICES);
    ledger.record('session-a', 'toolu_a', PROBE_DELEGATE);
    ledger.settle('session-a', PROBE_RESULT);

    // Another session's usage read must not add A's delegate to ITS bound.
    expect(ledger.takeSettledUsd('session-b')).toBe(0);
    ledger.settle('session-a', PROBE_RESULT);
    expect(ledger.takeSettledUsd('session-a')).toBe(0);

    ledger.record('session-a', 'toolu_b', PROBE_DELEGATE);
    ledger.settle('session-a', PROBE_RESULT);
    expect(ledger.takeSettledUsd('session-a')).toBeCloseTo(0.2263, 4);
  });

  it('stays anchored to the CLI’s own bill when the catalog’s prices move', () => {
    // A catalog at TWICE the prices halves the solved factor, so the delegate
    // still costs what the turn's own figure says its share was — the
    // calibration, not the catalog, is what the dollars rest on.
    const ledger = new ClaudeDelegateCostLedger(catalogClaudePrices(2));
    ledger.record(SESSION, 'toolu_a', PROBE_DELEGATE);

    const [priced] = ledger.settle(SESSION, PROBE_RESULT);

    expect(priced?.costUsd).toBeCloseTo(0.2263, 4);
  });

  it('prices nothing at all when it was handed no catalog', () => {
    // A history import's ledger, and the shape every unknown model degrades
    // to: tokens without dollars, never a guessed figure.
    const ledger = new ClaudeDelegateCostLedger();
    ledger.record(SESSION, 'toolu_a', PROBE_DELEGATE);

    expect(ledger.settle(SESSION, PROBE_RESULT)).toEqual([]);
    expect(ledger.takeSettledUsd(SESSION)).toBeNull();
  });
});

describe('listCostUsd', () => {
  it('prices the CANONICAL model at the catalog’s own cache rates', () => {
    // `[1m]` is dropped before the lookup; cache traffic is billed at the
    // catalog's cache_read / cache_write, not at a multiple of input.
    expect(
      listCostUsd(
        'claude-opus-5[1m]',
        {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheCreationTokens: 1_000_000,
        },
        PRICES,
      ),
    ).toBeCloseTo(5 + 25 + 0.5 + 6.25, 10);
  });

  it('answers null for a model the catalog does not list', () => {
    expect(
      listCostUsd(
        'claude-mythos-5',
        {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        PRICES,
      ),
    ).toBeNull();
  });
});
