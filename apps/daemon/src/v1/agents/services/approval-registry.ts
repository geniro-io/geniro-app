import { Injectable } from '@nestjs/common';

import type { RunAwaiting } from '../chat.types';

/** One paused tool call waiting on a user verdict. */
export interface PendingApproval {
  runId: string;
  nodeId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  /**
   * Whether this is the agent ASKING something (AskUserQuestion and its
   * per-CLI equivalents) rather than a tool call held at the permission gate.
   *
   * Recorded by the tracker rather than re-derived here, because deciding it
   * needs that CLI's own `questionToolName` — an adapter fact
   * (`.claude/rules/agent-adapters.md`), and both tracking sites have already
   * computed it to choose the card they persist. A registry that re-answered it
   * would be a second reading of the same question, free to disagree with the
   * card the user is looking at.
   */
  question: boolean;
  /**
   * Whether this card OUTLIVES the turn that raised it — a question whose
   * agent was told to stop and wait, because its CLI's MCP client will not
   * hold a call open for a person (`AdapterConfig.hostQuestionDeferredReason`).
   *
   * It is the one entry {@link ApprovalRegistry.sweepNode} leaves alone. Every
   * other pending card is a PARKED CALL, so a settled turn means nobody is on
   * the line and the card has to be retired or its buttons answer into
   * nothing; this one has no call behind it by construction — its `respond`
   * starts a new turn — so the settle says nothing about whether it can still
   * be answered. Retiring it at the settle is exactly the "expired — the turn
   * ended before an answer" the deferred ask exists to stop.
   *
   * Absent means false, so nothing that tracks an ordinary approval changes.
   */
  deferred?: boolean;
  /**
   * Delivers the verdict to the owning turn (persisting the verdict item on
   * success). Returns whether the turn was still live to receive it.
   * `answer` carries the user's picked option / typed text for a question
   * card (AskUserQuestion) — absent for plain tool approvals.
   *
   * On a {@link deferred} entry there is no turn to be live: it persists the
   * verdict and starts a new one, and its `true` means the answer was accepted
   * rather than that anything received it synchronously.
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

  /**
   * Drop ONE pending approval without delivering a verdict, and return what was
   * dropped — or null when it had already been answered or swept.
   *
   * The single-request twin of {@link sweepNode}, carrying the same obligation:
   * the caller MUST record the returned entry as an `unanswerable` transcript
   * item, or the card stays on the user's screen with live buttons that answer
   * into nothing.
   *
   * Separate from {@link resolve} because there is no verdict to deliver. This
   * is the CALLER giving up on its own call (an agent whose MCP client timed
   * the tool call out — see `ChatService`'s `abandonOnCancel`), and writing an
   * `approval_verdict` for it would put into the transcript an answer the user
   * never gave.
   */
  abandon(runId: string, requestId: string): PendingApproval | null {
    const key = this.key(runId, requestId);
    const entry = this.pending.get(key);
    if (!entry) {
      return null;
    }
    this.pending.delete(key);
    return entry;
  }

  /**
   * Drop every pending approval of one node's turn (turn settled or died) and
   * return what was dropped.
   *
   * The caller MUST record each returned entry as an `unanswerable` transcript
   * item (`utils/unanswerable.ts`): the card is already on the user's screen
   * with live buttons, and dropping the entry here only makes a verdict fail
   * silently. Returning the entries rather than void is what lets every settle
   * path close its cards from the same data the sweep acted on.
   */
  sweepNode(runId: string, nodeId: string): PendingApproval[] {
    const swept: PendingApproval[] = [];
    for (const [key, entry] of this.pending) {
      // A DEFERRED card is not this turn's to retire — see `PendingApproval`.
      if (entry.runId === runId && entry.nodeId === nodeId && !entry.deferred) {
        this.pending.delete(key);
        swept.push(entry);
      }
    }
    return swept;
  }

  /**
   * Drop every DEFERRED card of one run and return what was dropped — the
   * counterpart of {@link sweepNode} for the entries it deliberately skips.
   *
   * It carries the same obligation: each returned entry MUST be written as an
   * `unanswerable` transcript item, or the card stays on screen answering into
   * nothing.
   *
   * Two callers, and they are the two ways a standing question stops being the
   * thing the run is waiting on. A NEW TURN supersedes it — the user typed
   * something else, so the agent has already moved on and a card offering to
   * answer a question it is no longer asking is a trap. And a run TEARDOWN
   * takes it with everything else.
   */
  sweepDeferred(runId: string): PendingApproval[] {
    const swept: PendingApproval[] = [];
    for (const [key, entry] of this.pending) {
      if (entry.runId === runId && entry.deferred === true) {
        this.pending.delete(key);
        swept.push(entry);
      }
    }
    return swept;
  }

  /**
   * What this run is parked on, for the badge — or null when it is parked on
   * nothing.
   *
   * A question outranks an approval when both are open: a turn holding a
   * permission gate AND a question is blocked on the question in the sense the
   * user cares about (the agent is asking them something), and "waiting for
   * approval" would send them looking for a button when what is on screen is a
   * prompt.
   *
   * Read from the live map rather than from the transcript, which is what makes
   * it correct for a run nobody is looking at: the persisted items would say
   * the same thing, but only a client subscribed to that run's room ever
   * receives them.
   */
  awaitingFor(runId: string): RunAwaiting | null {
    let found: RunAwaiting | null = null;
    for (const entry of this.pending.values()) {
      if (entry.runId !== runId) {
        continue;
      }
      if (entry.question) {
        return 'question';
      }
      found = 'approval';
    }
    return found;
  }

  /**
   * Pending approvals for a run. No production route serves this today — a
   * reconnecting client replays approval cards from the persisted items, not
   * from here — it exists as the specs' observation seam for the pending map.
   */
  listByRun(runId: string): PendingApproval[] {
    return [...this.pending.values()].filter((p) => p.runId === runId);
  }
}
