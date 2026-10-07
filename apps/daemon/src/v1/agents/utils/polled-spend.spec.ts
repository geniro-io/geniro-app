import { describe, expect, it } from 'vitest';

import {
  addPolledSpendToTotals,
  applyPolledSpend,
  nodePolledSpend,
  polledDollars,
  pollsSpendFor,
  withNodePolledSpend,
} from './polled-spend';

describe('applyPolledSpend', () => {
  const totals = { costUsd: null, costedTurns: 0, turns: 4 };

  it('puts the fetched cents on as dollars', () => {
    const out = applyPolledSpend(totals, {
      polledCostCents: 1436.9128770000002,
      polledCostEvents: 3,
    });
    expect(out.costUsd).toBeCloseTo(14.36912877, 8);
    expect(out.costedTurns).toBe(3);
    // Everything it was not asked about survives.
    expect(out.turns).toBe(4);
  });

  it('leaves a run nothing has priced ALONE, rather than claiming zero', () => {
    // A null cost is what the header draws as "no cost reported"; a zero would
    // say the thread was free, which is a different and false statement.
    expect(
      applyPolledSpend(totals, {
        polledCostCents: null,
        polledCostEvents: null,
      }),
    ).toEqual(totals);
    expect(
      applyPolledSpend(totals, { polledCostCents: 0, polledCostEvents: 0 }),
    ).toEqual(totals);
  });
});

describe('addPolledSpendToTotals', () => {
  it('adds the polled bill to what other agents priced', () => {
    const out = addPolledSpendToTotals(
      { costUsd: 52.41, costedTurns: 23, turns: 25 },
      { polledCostCents: 729, polledCostEvents: 2 },
    );
    expect(out.costUsd).toBeCloseTo(59.7, 10);
    expect(out.costedTurns).toBe(25);
  });

  it('leaves totals alone when nothing was polled', () => {
    const totals = { costUsd: null, costedTurns: 0 };
    expect(
      addPolledSpendToTotals(totals, {
        polledCostCents: null,
        polledCostEvents: null,
      }),
    ).toBe(totals);
  });
});

describe('nodePolledSpend', () => {
  const polled = (kind: string | null) => kind === 'cursor-agent';

  it('answers a polled node’s own figure', () => {
    expect(
      nodePolledSpend(
        {
          agentKind: 'cursor-agent',
          polledCostCents: 300,
          polledCostEvents: 1,
        },
        polled,
      ),
    ).toEqual({ polledCostCents: 300, polledCostEvents: 1 });
  });

  it('never gives a node of a self-pricing CLI a polled bill', () => {
    // Its turns carry their own price; a stray figure on its row must not be
    // read as a second one.
    expect(
      nodePolledSpend(
        { agentKind: 'claude', polledCostCents: 300, polledCostEvents: 1 },
        polled,
      ),
    ).toEqual({ polledCostCents: null, polledCostEvents: null });
  });
});

describe('nodePolledSpend — agent pool', () => {
  const polled = (kind: string | null) => kind === 'cursor-agent';

  it('answers a pooled node’s bill when a member other than its stamp polls', () => {
    expect(
      nodePolledSpend(
        { agentKind: 'claude', polledCostCents: 300, polledCostEvents: 1 },
        polled,
        ['claude', 'cursor-agent'],
      ),
    ).toEqual({ polledCostCents: 300, polledCostEvents: 1 });
  });
});

describe('withNodePolledSpend', () => {
  const totals = { costUsd: 2, costedTurns: 3 };
  const bill = { polledCostCents: 500, polledCostEvents: 4 };
  const noTurns = { costUsd: null, costedTurns: 0 };

  it('replaces a polled node’s turn totals with its bill', () => {
    expect(withNodePolledSpend(totals, noTurns, bill)).toEqual({
      costUsd: 5,
      costedTurns: 4,
    });
  });

  it('adds the bill to the turns a self-pricing member priced, and to them alone', () => {
    // $2 over three turns, of which one $0.50 turn ran on a self-pricing
    // member: the bill stands for the other two.
    expect(
      withNodePolledSpend(totals, { costUsd: 0.5, costedTurns: 1 }, bill),
    ).toEqual({ costUsd: 5.5, costedTurns: 5 });
  });

  it('leaves every turn’s own figure while the bill is unpriced', () => {
    expect(
      withNodePolledSpend(totals, noTurns, {
        polledCostCents: null,
        polledCostEvents: null,
      }),
    ).toEqual(totals);
  });
});

describe('pollsSpendFor', () => {
  const adapters = new Map([
    ['claude', { getConfig: () => ({ usage: { polledSpend: false } }) }],
    ['cursor-agent', { getConfig: () => ({ usage: { polledSpend: true } }) }],
  ]);

  it('reads each CLI’s own declaration', () => {
    expect(pollsSpendFor(adapters, 'cursor-agent')).toBe(true);
    expect(pollsSpendFor(adapters, 'claude')).toBe(false);
  });

  it('polls nothing for an absent or unregistered kind', () => {
    expect(pollsSpendFor(adapters, null)).toBe(false);
    expect(pollsSpendFor(adapters, 'gemini-cli')).toBe(false);
  });
});

describe('polledDollars', () => {
  it('converts a priced bill and answers null for anything unpriced', () => {
    expect(polledDollars({ polledCostCents: 250, polledCostEvents: 2 })).toBe(
      2.5,
    );
    expect(
      polledDollars({ polledCostCents: 250, polledCostEvents: 0 }),
    ).toBeNull();
    expect(polledDollars(undefined)).toBeNull();
  });
});
