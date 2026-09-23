/**
 * Where a message typed into an OPEN thread goes: straight to the agent, or
 * into this thread's queue. The whole rule, in one place — the composer's send
 * path, its button, the button's label and the placeholder all read it, so they
 * cannot say different things about one press. The table it implements is in
 * `apps/ui/CLAUDE.md` → *When a message queues*.
 *
 * ONE principle decides every row: **a message goes straight in when the agent
 * will read it soon, and queues when the agent is busy with something that
 * keeps it from reading until that thing ends.** Queued, the user can still
 * edit, reorder or withdraw it; the strip's "Send now" is the explicit way to
 * push it into the turn anyway.
 *
 * - The agent producing its answer — thinking, writing, running a tool — is
 *   busy. That INCLUDES a tool call that blocks on other work: a SYNC sub-agent
 *   (Claude's `Task` without `run_in_background`) or a long foreground command.
 *   Neither counts as background work; the daemon only announces a unit as
 *   background once the CLI says the launching call is no longer waiting on it
 *   (`background_work.foreground` / `backgrounded` in the daemon).
 * - The agent PARKED — it has said its piece, or it is waiting on work it will
 *   be told about — reads a message at once. {@link parkedReason} names the
 *   five ways the daemon reports that.
 */

/**
 * Why a run reads `running` while its agent is not producing a reply — each of
 * these is a state in which a message typed now is read at once. Listed in the
 * order {@link parkedReason} tests them; the first match names the state.
 */
export type ParkedReason =
  /** The turn is HELD: the agent's reply is over and the process waits for the
   *  background sub-agents it launched to report (`holdingFor`). */
  | 'held'
  /** A workflow manager inside `await_agent` / a sync `call_agent` on its own
   *  callees. The daemon RELEASES that wait when a user message arrives
   *  (`CallBroker.interruptWaits`), so the manager reads it in seconds. */
  | 'awaiting-calls'
  /** A workflow whose manager has ENDED its turn while calls it started run
   *  on: the message starts the next pass. */
  | 'roots-idle'
  /** Sub-agents the agent launched IN THE BACKGROUND and did not wait for. */
  | 'background-subagents'
  /** A command the agent DETACHED — a dev server, a watcher. */
  | 'background-shells';

/** The five run facts the daemon announces, as the composer holds them. */
export interface ParkedFacts {
  held: boolean;
  awaitingCalls: boolean;
  rootsIdle: boolean;
  subagentsOut: boolean;
  shellsOut: boolean;
}

/** Which parked state the run is in, or null when none of them holds. */
export function parkedReason(facts: ParkedFacts): ParkedReason | null {
  if (facts.held) {
    return 'held';
  }
  if (facts.awaitingCalls) {
    return 'awaiting-calls';
  }
  if (facts.rootsIdle) {
    return 'roots-idle';
  }
  if (facts.subagentsOut) {
    return 'background-subagents';
  }
  if (facts.shellsOut) {
    return 'background-shells';
  }
  return null;
}

export interface FollowUpFacts extends ParkedFacts {
  /** A turn is in flight, as the renderer believes it. */
  streaming: boolean;
  /** Something the user wrote EARLIER is still in this thread's queue. */
  queued: boolean;
}

export type FollowUpDecision =
  | { action: 'send' }
  | {
      action: 'queue';
      /**
       * `agent-working` — the agent is busy; the drain fires on its turn's
       * terminal item. `behind-queue` — the agent could take it, but an older
       * message is waiting, and a queue the composer can jump is not a queue.
       */
      rule: 'agent-working' | 'behind-queue';
      /**
       * Whether the caller must kick the drain itself. Only behind an agent that
       * is NOT working: there is no turn whose ending would fire it, and a drain
       * kicked while the agent works spends its RUN_BUSY backoff refusing.
       */
      kickDrain: boolean;
    };

/** The composer's decision for one press. */
export function followUpDelivery(facts: FollowUpFacts): FollowUpDecision {
  const working = facts.streaming && parkedReason(facts) === null;
  if (working) {
    return { action: 'queue', rule: 'agent-working', kickDrain: false };
  }
  if (facts.queued) {
    return { action: 'queue', rule: 'behind-queue', kickDrain: true };
  }
  return { action: 'send' };
}

/**
 * The Send button's hover sentence while a running thread takes a message
 * straight in — ONE per parked state, because "the agent is idle, waiting on
 * its sub-agents" was the only sentence for all five and was false for four.
 */
export const PARKED_SEND_TITLE: Record<ParkedReason, string> = {
  held: 'Send — the agent has finished its reply and is only waiting on background sub-agents',
  'awaiting-calls':
    'Send — the manager is waiting on its agents, and a message releases the wait',
  'roots-idle':
    'Send — the manager has ended its turn while its agents work on',
  'background-subagents':
    'Send — sub-agents are running in the background; the agent is not waiting on them',
  'background-shells':
    'Send — a command is running in the background; the agent is not waiting on it',
};
