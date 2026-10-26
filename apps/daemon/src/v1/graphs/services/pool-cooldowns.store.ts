import type { AgentFailureClass } from '../../agents/adapters/adapter.types';
import { effectiveAccountKey } from '../../agents/utils/plan-limits-ledger';
import type { AgentKind } from '../../runs/runs.types';
import type {
  PoolStanding,
  WorkflowAgentNode,
  WorkflowAgentPoolMember,
} from '../graphs.types';
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
  WorkflowAgentPoolMember,
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
 * every run sees it. Any other failure is filed only for the run and node that
 * met it.
 *
 * Held in memory only: after a daemon restart the first attempt on a spent
 * member fails again and records its window anew.
 */
export class PoolCooldowns {
  /** `limit` records, by account: a usage window belongs to every run on it. */
  private readonly limits = new Map<string, number>();
  /**
   * `unavailable` records, by the site that met them and the account: an
   * ordinary failure may be that node's own (its prompt, its MCP config), so it
   * reorders only the node it happened to.
   */
  private readonly failures = new Map<string, number>();

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
    if (this.live(this.limits, account)) {
      return 'limit';
    }
    return this.live(this.failures, siteKey(site, account))
      ? 'unavailable'
      : null;
  }

  /**
   * Every member of `node`'s pool read at one instant, and the order a new
   * conversation tries them in (`poolAttemptOrder`). Read once, since a window
   * reopening between two reads would leave a member out of the order.
   */
  order(
    node: WorkflowAgentNode,
    site: PoolSite,
  ): { standings: (PoolStanding | null)[]; order: number[] } {
    const standings = Array.from({ length: poolSize(node) }, (_, i) =>
      this.standing(poolMemberNode(node, i + 1)!, site),
    );
    return { standings, order: poolAttemptOrder(standings) };
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
          ? reopens
          : now + POOL_COOLDOWN_FALLBACK_MS,
      );
    } else if (handedPast) {
      this.failures.set(
        siteKey(site, account),
        now + POOL_COOLDOWN_FALLBACK_MS,
      );
    }
  }

  private live(records: Map<string, number>, key: string): boolean {
    const until = records.get(key);
    if (until === undefined) {
      return false;
    }
    if (until > this.now()) {
      return true;
    }
    records.delete(key);
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

/** Where an attempt ran: the run's folder (for its account pin) and the node. */
export interface PoolSite {
  cwd: string | null;
  runId: string;
  nodeId: string;
}

function siteKey(site: PoolSite, account: string): string {
  return [site.runId, site.nodeId, account].join('\u0000');
}
