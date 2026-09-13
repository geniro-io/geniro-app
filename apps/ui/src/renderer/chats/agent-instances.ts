import {
  type AgentDisplay,
  type AgentThread,
  MAIN_THREAD_ID,
} from './agent-activity';
import { isSettledRunStatus } from './run-status';
import type { ShellRun } from './shell-activity';
import type { AgentTaskRow } from './task-payload';

/**
 * One INSTANCE of an agent — one conversation it holds — with everything that
 * happened inside it: the delegates it launched, the commands it has running,
 * and the checklist it keeps.
 *
 * A workflow node can be CALLED many times, and each call is a conversation of
 * its own, running beside the others: a Manager that sends its Engineer three
 * briefs has three Engineers at work. The panel used to pool all of it under
 * the node — every instance's sub-agents in one list, their commands in one
 * band, their task lists folded into one plan that belonged to none of them —
 * so which Engineer was running `pnpm test`, and which one was stuck on step 3,
 * had no answer on screen. Reported as "всё в перемешку".
 */
export interface AgentInstance {
  /** The conversation itself — the node's own (`main`), or a call thread. */
  thread: AgentThread;
  /** The delegates this conversation launched, in launch order. */
  subagents: AgentThread[];
  /** The commands this conversation has running. */
  shells: ShellRun[];
  /** This conversation's own task list — empty when it keeps none. */
  tasks: readonly AgentTaskRow[];
}

/** One task list of one agent, keyed by the conversation it was kept in. */
export interface InstanceTaskList {
  /** {@link MAIN_THREAD_ID} for the node's own conversation, else the call id. */
  threadId: string;
  tasks: readonly AgentTaskRow[];
}

/** The thread id a call id names — the call itself, or the node's own. */
export function threadIdOfCall(callId: string | null | undefined): string {
  return callId ?? MAIN_THREAD_ID;
}

interface Bucket {
  subagents: AgentThread[];
  shells: ShellRun[];
  tasks: readonly AgentTaskRow[];
}

/**
 * Split one agent's delegates, commands and task lists by the conversation
 * each belongs to — its own first, then every call thread in call order.
 *
 * A bucket whose conversation the agent's threads do not name is still
 * returned, as an INFERRED instance, never dropped and never poured into
 * another one. It is reachable: the daemon folds every task list the run ever
 * wrote while the call threads come from the loaded transcript window, so a
 * long thread's early calls can have a list and no `call_started` on screen.
 * Pouring that list into the node's own conversation is the mixing this module
 * exists to undo. The inferred call is placed before the known ones — it is
 * older than anything the window holds — and is `running` only while something
 * in it demonstrably is, else `completed`: its opening is outside the window,
 * and a call whose every remaining trace is settled has ended.
 */
export function agentInstances(
  agent: AgentDisplay,
  shells: readonly ShellRun[] = [],
  taskLists: readonly InstanceTaskList[] = [],
): AgentInstance[] {
  const buckets = new Map<string, Bucket>();
  const bucket = (threadId: string): Bucket => {
    let found = buckets.get(threadId);
    if (found === undefined) {
      found = { subagents: [], shells: [], tasks: [] };
      buckets.set(threadId, found);
    }
    return found;
  };
  for (const thread of agent.threads) {
    if (thread.kind === 'subagent') {
      bucket(threadIdOfCall(thread.callId)).subagents.push(thread);
    }
  }
  for (const shell of shells) {
    bucket(threadIdOfCall(shell.callId)).shells.push(shell);
  }
  for (const list of taskLists) {
    if (list.tasks.length > 0) {
      bucket(list.threadId).tasks = list.tasks;
    }
  }

  const conversations = agent.threads.filter(
    (thread) => thread.kind !== 'subagent',
  );
  const known = new Set(conversations.map((thread) => thread.id));
  const out: AgentInstance[] = [];
  const empty: Bucket = { subagents: [], shells: [], tasks: [] };
  const take = (thread: AgentThread, content: Bucket = empty): void => {
    out.push({ thread, ...content });
  };

  const main = conversations.find((thread) => thread.id === MAIN_THREAD_ID);
  const mainBucket = buckets.get(MAIN_THREAD_ID);
  if (main !== undefined) {
    take(main, mainBucket);
  } else if (mainBucket !== undefined) {
    // Rows with no call tag on a node that ran no turn of its own — nothing
    // else can claim them, and the card's own status is the only reading.
    take(
      {
        id: MAIN_THREAD_ID,
        kind: 'main',
        label: 'Main conversation',
        status: agent.status,
        sessionId: null,
      },
      mainBucket,
    );
  }
  for (const [threadId, content] of buckets) {
    if (threadId === MAIN_THREAD_ID || known.has(threadId)) {
      continue;
    }
    const working =
      content.shells.length > 0 ||
      content.subagents.some((thread) => !isSettledRunStatus(thread.status));
    take(
      {
        id: threadId,
        kind: 'call',
        label: threadId,
        status: working ? 'running' : 'completed',
        sessionId: null,
      },
      content,
    );
  }
  for (const thread of conversations) {
    if (thread.id !== MAIN_THREAD_ID) {
      take(thread, buckets.get(thread.id));
    }
  }
  return out;
}

/**
 * Whether an instance is still producing anything — the ones the panel keeps
 * OPEN.
 *
 * Its own status first, and then what is still running inside it: a call that
 * settled can leave a detached command running, and a delegate can outlive the
 * turn that launched it — both are work on this machine the reader opened the
 * panel to see.
 */
export function isInstanceLive(instance: AgentInstance): boolean {
  return (
    !isSettledRunStatus(instance.thread.status) ||
    instance.shells.length > 0 ||
    instance.subagents.some((thread) => !isSettledRunStatus(thread.status))
  );
}

/** Whether an instance has anything to show beyond its own heading row. */
export function hasInstanceContent(instance: AgentInstance): boolean {
  return (
    instance.subagents.length > 0 ||
    instance.shells.length > 0 ||
    instance.tasks.length > 0
  );
}
