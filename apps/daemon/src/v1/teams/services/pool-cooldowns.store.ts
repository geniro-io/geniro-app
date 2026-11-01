import type { AgentFailureClass } from '../../agents/adapters/adapter.types';
import { effectiveAccountKey } from '../../agents/utils/plan-limits-ledger';
import type { AgentKind } from '../../runs/runs.types';
import type {
  PoolStanding,
  TeamAgentPoolMember,
  TeamMember,
} from '../teams.types';
import {
  poolAttemptOrder,
  poolMemberNode,
  poolSize,
} from '../utils/agent-pool';
import { resetInstantFrom } from '../utils/reset-instant';

/**
 * How long a spent pool member stays spent when its failure named no instant
 * it reopens at. A guess either way, so a member it covers is still tried when
 * the others fail.
 */
export const POOL_COOLDOWN_FALLBACK_MS = 30 * 60 * 1000;

/** What identifies a member to {@link PoolCooldowns}, beside the folder it runs in. */
export type PoolCooldownMember = Pick<
  TeamAgentPoolMember,
  'agent' | 'configDir' | 'model'
>;

/** The part of a settled attempt the record reads. */
export interface PoolAttemptResult {
  status: 'completed' | 'failed' | 'cancelled';
  failureClass: AgentFailureClass | null;
  resetsAt: string | null;
}

/**
 * Pool members found spent, until the instant they are expected to work again,
 * shared by every run of the daemon.
 *
 * A limit belongs to an ACCOUNT, so it is filed by the account a member
 * actually runs on — the folder's pin, else its profile, canonicalized
 * (`effectiveAccountKey`, the plan-limits ledger's own key) — and its model,
 * since a plan can cap one model while the account still serves the others;
 * every run sees it. Any other failure is filed only for the run and team member
 * that met it.
 *
 * A member is PROVEN available (`proven`) only on evidence: its account
 * answered since the daemon started, or its limit ran out at the instant its
 * CLI named. A cooldown that was a guess lapsing proves nothing, and neither
 * does knowing nothing — so a conversation is moved back to an earlier member
 * only on proof, while a new conversation still tries it first.
 *
 * Held in memory only: after a daemon restart nothing is spent and nothing is
 * proven, so the first attempt on a spent member fails again and records its
 * window anew.
 */
export class PoolCooldowns {
  /** `limit` records, by account: a usage window belongs to every run on it. */
  private readonly limits = new Map<string, LimitRecord>();
  /**
   * `unavailable` records, by the site that met them and the account: an
   * ordinary failure may be that team member's own (its prompt, its MCP config), so
   * it reorders only the team member it happened to.
   */
  private readonly failures = new Map<string, number>();
  /** Accounts that answered, or whose named reset passed, since their last limit. */
  private readonly reopened = new Set<string>();
  /** Sites whose guessed cooldown lapsed with no answer from the member since. */
  private readonly doubted = new Set<string>();

  /**
   * @param pinnedConfigDir The profile `cwd` pins for `agent`, or null — the
   *   daemon passes `ConfigDirPinService`; without one nothing is pinned.
   */
  constructor(
    private readonly pinnedConfigDir: (
      agent: AgentKind,
      cwd: string,
    ) => string | null = () => null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Whether `member` is spent now, as seen from `site`, and why; null when it is not. */
  standing(member: PoolCooldownMember, site: PoolSite): PoolStanding | null {
    const account = this.accountOf(member, site.cwd);
    if (this.liveLimit(account)) {
      return 'limit';
    }
    return this.liveFailure(siteKey(site, account)) ? 'unavailable' : null;
  }

  /** Whether `member` is known to work again, as seen from `site`. */
  proven(member: PoolCooldownMember, site: PoolSite): boolean {
    const account = this.accountOf(member, site.cwd);
    const key = siteKey(site, account);
    return (
      this.standing(member, site) === null &&
      this.reopened.has(account) &&
      !this.doubted.has(key)
    );
  }

  /**
   * Every pool member of `node` read at one instant, and the order a new
   * conversation tries them in (`poolAttemptOrder`). Read once, since a window
   * reopening between two reads would leave a member out of the order.
   */
  order(
    node: TeamMember,
    site: PoolSite,
  ): {
    standings: (PoolStanding | null)[];
    proven: boolean[];
    order: number[];
  } {
    const members = Array.from({ length: poolSize(node) }, (_, i) =>
      poolMemberNode(node, i + 1)!,
    );
    const standings = members.map((member) => this.standing(member, site));
    const proven = members.map((member) => this.proven(member, site));
    return { standings, proven, order: poolAttemptOrder(standings) };
  }

  /**
   * Record one settled attempt of `member` at `site`. An answer reopens it. A
   * failure spends it when its account failed it, for everyone; or, at this
   * site only, when the work was handed PAST it for any other reason — which
   * is what covers a CLI whose limit wording no adapter recognises yet. A crash
   * mid-work it kept is not its account's.
   */
  record(
    member: PoolCooldownMember,
    site: PoolSite,
    result: PoolAttemptResult,
    handedPast: boolean,
  ): void {
    const account = this.accountOf(member, site.cwd);
    if (result.status === 'completed') {
      this.limits.delete(account);
      this.failures.delete(siteKey(site, account));
      this.doubted.delete(siteKey(site, account));
      this.reopened.add(account);
      return;
    }
    if (result.status !== 'failed') {
      return;
    }
    const now = this.now();
    if (
      result.failureClass === 'rate_limited' ||
      result.failureClass === 'auth_expired'
    ) {
      const reopens =
        result.resetsAt !== null
          ? resetInstantFrom(result.resetsAt, new Date(now))
          : null;
      this.limits.set(
        account,
        reopens !== null && reopens > now
          ? { until: reopens, exact: true }
          : { until: now + POOL_COOLDOWN_FALLBACK_MS, exact: false },
      );
      this.reopened.delete(account);
    } else if (handedPast) {
      this.failures.set(
        siteKey(site, account),
        now + POOL_COOLDOWN_FALLBACK_MS,
      );
      this.doubted.delete(siteKey(site, account));
    }
  }

  private liveLimit(account: string): boolean {
    const record = this.limits.get(account);
    if (record === undefined) {
      return false;
    }
    if (record.until > this.now()) {
      return true;
    }
    this.limits.delete(account);
    if (record.exact) {
      this.reopened.add(account);
    }
    return false;
  }

  private liveFailure(key: string): boolean {
    const until = this.failures.get(key);
    if (until === undefined) {
      return false;
    }
    if (until > this.now()) {
      return true;
    }
    this.failures.delete(key);
    this.doubted.add(key);
    return false;
  }

  private accountOf(member: PoolCooldownMember, cwd: string | null): string {
    const pinned =
      cwd === null ? null : this.pinnedConfigDir(member.agent, cwd);
    return [
      effectiveAccountKey(member.agent, member.configDir ?? null, pinned, cwd),
      member.model ?? '',
    ].join('\u0000');
  }
}

/** A `limit` record: until when, and whether the CLI named that instant. */
interface LimitRecord {
  until: number;
  exact: boolean;
}

/** Where an attempt ran: the run's folder (for its account pin) and the team member. */
export interface PoolSite {
  cwd: string | null;
  runId: string;
  memberId: string;
}

function siteKey(site: PoolSite, account: string): string {
  return [site.runId, site.memberId, account].join('\u0000');
}
