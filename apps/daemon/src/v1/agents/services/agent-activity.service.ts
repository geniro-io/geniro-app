import { Injectable } from '@nestjs/common';

import { AgentSessionRegistry } from './agent-session.registry';
import { ApprovalRegistry } from './approval-registry';
import { ProcessRegistry } from './process-registry';

/** How long after a run's last turn a command it left running still counts as work. */
export const DETACHED_WORK_MS = 60 * 60_000;

/**
 * `ProcessRegistry` keys that are agent work besides a run's own turn (keyed
 * by the bare run id). Every other prefixed key is the daemon's own errand —
 * a model listing, a version probe, a sign-in.
 */
const WORK_KEY_PREFIXES = ['monitor:', 'action:'];

/**
 * Is an agent at work: a run's turn not blocked on the user, a monitor, a
 * command action, or a kept CLI working between turns. Narrower than the
 * idle exit's rule, which keeps the daemon up for anything it must not kill:
 * a turn waiting on a card and a dev server nobody has used for an hour are
 * not work here.
 */
@Injectable()
export class AgentActivityService {
  private blockedConversations: (runId: string) => number | null = () => null;

  constructor(
    private readonly processes: ProcessRegistry,
    private readonly sessions: AgentSessionRegistry,
    private readonly approvals: ApprovalRegistry,
  ) {}

  get working(): boolean {
    return (
      this.processes.activeKeys().some((key) => this.isWork(key)) ||
      this.sessions.worksBetweenTurns(DETACHED_WORK_MS)
    );
  }

  /**
   * How many of a team run's conversations are blocked — waiting on their own
   * calls, or on a card — answered by the team module, which this one may not
   * import. Null for a run it does not hold.
   */
  useBlockedConversations(reader: (runId: string) => number | null): void {
    this.blockedConversations = reader;
  }

  private isWork(key: string): boolean {
    if (!key.includes(':')) {
      return !this.waitsOnUser(key);
    }
    return WORK_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
  }

  /**
   * Whether every turn the run has in flight is blocked, so all of it waits
   * on the user: a team caller waiting on a callee that waits on a card is
   * blocked too, while one member's card leaves the others working.
   */
  private waitsOnUser(runId: string): boolean {
    const blocked =
      this.blockedConversations(runId) ?? this.cardedConversations(runId);
    return blocked > 0 && this.sessions.turnsInFlight(runId) <= blocked;
  }

  /** A standing card outlives its turn, so the turn the next message opened is not waiting on it. */
  private cardedConversations(runId: string): number {
    return new Set(
      this.approvals
        .listByRun(runId)
        .filter((card) => card.standing !== true)
        .map((card) => card.memberId),
    ).size;
  }
}
