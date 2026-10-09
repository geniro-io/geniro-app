import type { PlanLimitsWire } from '../chat.types';

/**
 * The plan limits of each ACCOUNT, as the freshest trustworthy reading any of
 * its agents gave — so every chat on one account shows the same figures.
 *
 * An allowance belongs to the account, but the only way to ASK about it is
 * through one conversation's own CLI process, so each chat used to show
 * whatever its own process last said. REPORTED as "на каждом трэде я вижу
 * разные лимиты по подписке", with two screenshots taken a minute apart on one
 * account: `Current session 45% · Current week 54%` in one thread and
 * `96% · 59%` plus a `Current week · Fable` row in the other. Both were honest
 * answers from different processes — the first a SEEDED one (claude could not
 * reach its usage endpoint and fell back to its own last request's headers,
 * which is also why the model-scoped row was missing), the second the
 * endpoint's. So the ledger does two things the per-chat path could not: it
 * lets every chat see a reading another chat took, and it ranks a real reading
 * above an estimated one rather than taking whichever arrived last.
 *
 * In memory, keyed by the caller's account key (`accountKeyOf`). A restart
 * forgets it, which costs only the cross-chat sharing until the next reading —
 * each run still keeps its own last reading on its row.
 */
export class PlanLimitsLedger {
  private readonly entries = new Map<string, PlanReading>();

  /**
   * Offer one reading and answer with the best this account now has — the
   * offered one, or a better one some other chat took.
   *
   * Null `offered` only asks. Null `key` (a run naming no agent) has no
   * account to share with, so the offer is answered alone.
   */
  settle(
    key: string | null,
    offered: PlanReading | null,
    now: number,
  ): PlanReading | null {
    if (key === null) {
      return offered;
    }
    const held = this.entries.get(key);
    const live = held && now - held.takenAt <= LEDGER_MAX_AGE_MS ? held : null;
    const best = pickBetter(live, offered);
    if (best === null) {
      this.entries.delete(key);
    } else {
      this.entries.set(key, best);
    }
    return best;
  }

  /**
   * The account ANSWERED that it has no plan windows (an API-key account), so
   * whatever it reported before is no longer true of it.
   */
  forget(key: string | null): void {
    if (key !== null) {
      this.entries.delete(key);
    }
  }
}

/** One plan reading and the moment it was taken, in epoch milliseconds. */
export interface PlanReading {
  plan: PlanLimitsWire;
  takenAt: number;
}

/**
 * How long a held reading may stand in for an account nobody has asked since.
 *
 * Long on purpose: every reading is served WITH its age on screen, so an old
 * one is a dated fact rather than a claim about now — and the alternative for
 * a chat whose own agent is closed is nothing at all. Bounded at all because a
 * session window resets every five hours, past which no figure in it means
 * anything.
 */
export const LEDGER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * How long a reading from the usage service outranks a NEWER estimated one.
 *
 * An estimate is the CLI's own last request's headers, or an older persisted
 * snapshot, and the measured gap between the two kinds was 51 points on one
 * window — so a real reading a few minutes old is the better answer. Past this
 * the estimate's recency wins: the windows move, and a stale real figure is no
 * longer the more accurate of the two.
 *
 * Five minutes, down from thirty. REPORTED as a panel reading `Updated 17m
 * ago` through a whole working turn with no way to move it: every fresh answer
 * the agent gave in those minutes lost to the older real one, so re-opening
 * the panel and re-reading it changed nothing. Five minutes is the age past
 * which the user calls a reading stale and the panel re-asks on open, so a
 * real reading may not outrank a newer one for longer than that — and the
 * panel still says when what it shows is an estimate.
 */
export const REAL_READING_PREFERRED_MS = 5 * 60 * 1000;

/** The better of two readings of one account, either of which may be absent. */
export function pickBetter(
  a: PlanReading | null,
  b: PlanReading | null,
): PlanReading | null {
  if (a === null || b === null) {
    return a ?? b;
  }
  if (a.plan.estimated !== b.plan.estimated) {
    const real = a.plan.estimated ? b : a;
    const estimate = a.plan.estimated ? a : b;
    return estimate.takenAt - real.takenAt > REAL_READING_PREFERRED_MS
      ? estimate
      : real;
  }
  // Same kind: the newer one. A tie keeps the first, so re-offering the held
  // reading never churns it.
  return b.takenAt > a.takenAt ? b : a;
}

/**
 * The key one account's readings are filed under: which CLI, and which of its
 * config directories — a profile is an account, and a run names its own.
 *
 * Null for a run naming no agent, which has no account to share.
 */
export function accountKeyOf(
  agentKind: string | null,
  configDir: string | null,
): string | null {
  return agentKind === null ? null : `${agentKind}\u0000${configDir ?? ''}`;
}
