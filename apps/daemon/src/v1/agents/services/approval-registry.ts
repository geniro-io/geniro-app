import { Injectable } from '@nestjs/common';

/** One paused tool call waiting on a user verdict. */
export interface PendingApproval {
  runId: string;
  nodeId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  /**
   * Delivers the verdict to the owning turn (persisting the verdict item on
   * success). Returns whether the turn was still live to receive it.
   * `answer` carries the user's picked option / typed text for a question
   * card (AskUserQuestion) — absent for plain tool approvals.
   */
  respond: (allow: boolean, answer?: string) => boolean;
}

/**
 * In-flight approval requests across all runs, keyed by (runId, requestId).
 * The graph executor tracks a request when an `ask` node pauses; the WS
 * gateway resolves it when the user's verdict arrives. Entries are dropped on
 * resolve and swept when their node's turn settles (a turn that dies with a
 * pending approval must not leak it — resolve() on a swept entry is a no-op,
 * reported back to the gateway as `false`).
 */
@Injectable()
export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingApproval>();

  private key(runId: string, requestId: string): string {
    return `${runId}::${requestId}`;
  }

  track(approval: PendingApproval): void {
    this.pending.set(this.key(approval.runId, approval.requestId), approval);
  }

  /** Deliver a verdict; false when the request is unknown, settled, or dead. */
  resolve(
    runId: string,
    requestId: string,
    allow: boolean,
    answer?: string,
  ): boolean {
    const key = this.key(runId, requestId);
    const entry = this.pending.get(key);
    if (!entry) {
      return false;
    }
    this.pending.delete(key);
    // Arity-preserving: a plain approve/deny keeps the historical one-arg
    // call shape — responders can't observe the difference, but call-shape
    // assertions (spies) on the pre-M4 wire stay byte-identical.
    return answer === undefined
      ? entry.respond(allow)
      : entry.respond(allow, answer);
  }

  /** Drop every pending approval of one node's turn (turn settled or died). */
  sweepNode(runId: string, nodeId: string): void {
    for (const [key, entry] of this.pending) {
      if (entry.runId === runId && entry.nodeId === nodeId) {
        this.pending.delete(key);
      }
    }
  }

  /** Pending approvals for a run (reconnect snapshot). */
  listByRun(runId: string): PendingApproval[] {
    return [...this.pending.values()].filter((p) => p.runId === runId);
  }
}
