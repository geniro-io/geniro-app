/**
 * The arithmetic over a POLLED bill — money a CLI's ACCOUNT reported for a
 * conversation, which that CLI's turns do not carry (`AdapterConfig.usage
 * .polledSpend`). `PolledSpendService` stores it on the run row and on each
 * node's row; it is folded into totals here, in one place, so the thread
 * header, the waterfall and a node's readout cannot disagree about it.
 */

/** A polled bill as the run and node rows store it. */
export interface PolledSpend {
  polledCostCents: number | null;
  polledCostEvents: number | null;
}

/** The bill of a conversation nothing has priced. */
export const NO_POLLED_SPEND: PolledSpend = {
  polledCostCents: null,
  polledCostEvents: null,
};

/**
 * Put a polled bill onto a conversation's totals, REPLACING what its turns
 * said. For a CLI whose turns price nothing there is nothing to add to, and
 * adding would double-count the moment that CLI starts reporting, whereas
 * replacing simply stops mattering once a real figure exists.
 *
 * A bill with no events leaves the totals ALONE — untouched null, which the
 * header draws as "no cost reported". A zero would claim the thread was free.
 */
export function applyPolledSpend<
  T extends { costUsd: number | null; costedTurns: number },
>(totals: T, polled: PolledSpend): T {
  if (!isPriced(polled)) {
    return totals;
  }
  return {
    ...totals,
    costUsd: polled.polledCostCents / 100,
    costedTurns: polled.polledCostEvents ?? 0,
  };
}

/**
 * Put a polled bill ON TOP of turns another CLI priced — a workflow run, whose
 * other nodes report their cost per turn. Replacing there (as
 * {@link applyPolledSpend} rightly does for a single-CLI chat) would report the
 * polled node's bill as the whole run's cost.
 */
export function addPolledSpendToTotals<
  T extends { costUsd: number | null; costedTurns: number },
>(totals: T, polled: PolledSpend): T {
  if (!isPriced(polled)) {
    return totals;
  }
  return {
    ...totals,
    costUsd: (totals.costUsd ?? 0) + polled.polledCostCents / 100,
    costedTurns: totals.costedTurns + (polled.polledCostEvents ?? 0),
  };
}

/**
 * Whether an agent kind's money is polled from its account — its own adapter's
 * `usage.polledSpend`. An unknown or absent kind polls nothing.
 */
export function pollsSpendFor(
  adapters: ReadonlyMap<
    string,
    { getConfig(): { usage: { polledSpend: boolean } } }
  >,
  agentKind: string | null,
): boolean {
  return agentKind === null
    ? false
    : (adapters.get(agentKind)?.getConfig().usage.polledSpend ?? false);
}

/**
 * One workflow node's polled bill: its own row's, or none at all for a node
 * whose CLI prices its own turns.
 */
export function nodePolledSpend(
  state: PolledSpend & { agentKind: string | null },
  pollsSpend: (agentKind: string | null) => boolean,
): PolledSpend {
  return pollsSpend(state.agentKind)
    ? {
        polledCostCents: state.polledCostCents,
        polledCostEvents: state.polledCostEvents,
      }
    : NO_POLLED_SPEND;
}

/** A polled bill in dollars, or null when nothing was ever priced. */
export function polledDollars(polled: PolledSpend | undefined): number | null {
  return polled !== undefined && isPriced(polled)
    ? polled.polledCostCents / 100
    : null;
}

function isPriced(
  polled: PolledSpend,
): polled is PolledSpend & { polledCostCents: number } {
  return polled.polledCostCents !== null && (polled.polledCostEvents ?? 0) > 0;
}
