import type { EntityManager } from '@mikro-orm/sqlite';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import type { AgentTitleInput } from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { ItemWire, RunItemEvent, RunStatusEvent } from '../chat.types';
import { CHAT_TITLE_UPGRADE_TURNS, SINGLE_AGENT_NODE } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { NodeStateDao } from '../dao/node-state.dao';
import type { RunDao } from '../dao/run.dao';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import type { AgentEventBus } from './agent-events.bus';
import { ChatTitleService } from './chat-title.service';

/** One bus item, defaulting to the settled turn that triggers naming. */
function item(
  nodeId: string | null = null,
  kind: ItemWire['kind'] = 'turn_complete',
): ItemWire {
  return {
    id: 'i1',
    runId: 'run-a',
    nodeId,
    seq: 4,
    kind,
    role: null,
    payload: { stopReason: 'end_turn' },
    createdAt: new Date().toISOString(),
  };
}

function build(opts: {
  run?: Partial<Run> | null;
  nativeTitle?: string | null;
  readSessionTitle?: () => Promise<string | null>;
  /**
   * Rename the run from INSIDE the adapter read, i.e. while the service is
   * resolving. The only way to reach the lost-claim branch, which is what
   * withholds the announce.
   */
  renameDuringResolve?: string;
  firstUserMessageText?: string | null;
  /** The agent's first reply, which a generated title is also written from. */
  firstAssistantMessageText?: string | null;
  /** What the CLI answers when ASKED to name the chat; null = it cannot. */
  generatedTitle?: string | null;
  agentSessionId?: string | null;
}) {
  const items = new Subject<RunItemEvent>();
  const deleted = new Subject<string>();
  const statuses: RunStatusEvent[] = [];
  /**
   * The service's clock, driven by the spec.
   *
   * Injected rather than faked globally: `drain()` is a real `setTimeout(0)`,
   * so vitest's fake timers would have to be advanced by hand for every await
   * in the naming chain — and the only thing this service reads a clock for is
   * the early-naming cooldown.
   */
  let clock = 1_000_000;

  const row =
    opts.run === null
      ? null
      : {
          id: 'run-a',
          title: null,
          workflowId: null,
          agentKind: AgentKind.CursorAgent,
          ...opts.run,
        };
  /**
   * The run's title AS THE DATABASE HOLDS IT, kept apart from the entity handed
   * to `getById`.
   *
   * The distinction is what the lost-claim case turns on: a rename lands in the
   * database through another fork, so the entity this service loaded goes on
   * carrying the OLD title — which is exactly what it passes as the expected
   * value, and exactly why the conditional write can tell that it lost.
   */
  let storedTitle: string | null = row?.title ?? null;
  // Models the conditional write: the real one is a `title IS NULL` predicate
  // in SQL, so a row that already has a name reports back that this call is not
  // what named it.
  // Models the conditional write: the real one is a `title = expected`
  // predicate in SQL, so a row whose title has moved on reports back that this
  // call is not what named it.
  const retitle = vi.fn(
    (_id: string, title: string, expected: string | null) => {
      if (storedTitle !== expected) {
        return Promise.resolve(false);
      }
      storedTitle = title;
      return Promise.resolve(true);
    },
  );
  const readSessionTitle =
    opts.readSessionTitle ??
    vi.fn(() => {
      if (opts.renameDuringResolve !== undefined) {
        storedTitle = opts.renameDuringResolve;
      }
      return Promise.resolve(opts.nativeTitle ?? null);
    });
  // Typed on the INPUT, so a spec can assert what a later ask was given —
  // `vi.fn(() => …)` infers a zero-arity call signature and its `mock.calls`
  // become `[]`, which no assertion can reach into.
  const generateTitle = vi.fn((_input: AgentTitleInput) =>
    Promise.resolve(opts.generatedTitle ?? null),
  );
  const adapterFor = vi.fn(
    () => ({ readSessionTitle, generateTitle }) as unknown as AgentAdapter,
  );
  // Records its arguments rather than asserting inside them: this runs within
  // `readNativeTitle`'s try/catch, so a failed `expect` there would surface as a
  // swallowed warning and a confusing downstream mismatch instead of naming the
  // wrong node key.
  const getByRunNode = vi.fn(() =>
    Promise.resolve(
      opts.agentSessionId === undefined
        ? { agentSessionId: 'sess-1' }
        : { agentSessionId: opts.agentSessionId },
    ),
  );

  const service = new ChatTitleService(
    { fork: () => ({}) } as unknown as EntityManager,
    {
      all: () => items.asObservable(),
      allDeleted: () => deleted.asObservable(),
      publishRunStatus: (event: RunStatusEvent) => statuses.push(event),
    } as unknown as AgentEventBus,
    {
      // A fresh read each time, carrying the title the database holds now —
      // the identity map is per fork, and this service forks per naming.
      getById: () =>
        Promise.resolve(
          row === null ? null : ({ ...row, title: storedTitle } as Run),
        ),
      retitle,
    } as unknown as RunDao,
    {
      firstUserMessageText: () =>
        Promise.resolve(opts.firstUserMessageText ?? null),
      firstAssistantMessageText: () =>
        Promise.resolve(opts.firstAssistantMessageText ?? null),
      // A later ask reads the newest exchange rather than the opening one —
      // real text, so a spec asserting the retry carries something cannot pass
      // on a double that answers null for everything.
      lastUserMessageText: () =>
        Promise.resolve('so the ETA bindings are the problem'),
      lastAssistantMessageText: () =>
        Promise.resolve('Yes — I rewrote them and the suite is green.'),
    } as unknown as ItemDao,
    { getByRunNode } as unknown as NodeStateDao,
    { for: adapterFor } as unknown as AgentAdapterRegistry,
    () => clock,
  );
  service.onModuleInit();

  /**
   * Publish a settled turn and let the fire-and-forget naming drain.
   *
   * A single macrotask hop is enough and is not a guess: every collaborator
   * here is a resolved promise with no timer or IO behind it, so the whole
   * chain (run read → title read → message read → write → publish) is a run of
   * microtasks, and the queue is exhausted before any `setTimeout` callback is
   * reached.
   */
  const drain = (): Promise<unknown> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  const settle = async (nodeId: string | null = null): Promise<void> => {
    items.next({ runId: 'run-a', item: item(nodeId) });
    await drain();
  };

  /** An item of some other kind — a turn ending, or something nothing reacts to. */
  const settleKind = async (kind: ItemWire['kind']): Promise<void> => {
    items.next({ runId: 'run-a', item: item(null, kind) });
    await drain();
  };

  /** The user's own message — what names a chat before its turn ends. */
  const userMessage = async (): Promise<void> => {
    items.next({
      runId: 'run-a',
      item: { ...item(null, 'message'), role: 'user' },
    });
    await drain();
  };

  /** The agent's own message — what names a chat while its turn is still running. */
  const assistantMessage = async (): Promise<void> => {
    items.next({
      runId: 'run-a',
      item: { ...item(null, 'message'), role: 'assistant' },
    });
    await drain();
  };

  /**
   * The agent reaching for a TOOL — what names a chat on a turn where the agent
   * works before it says anything, which is most of them.
   */
  const toolCall = async (): Promise<void> => {
    items.next({ runId: 'run-a', item: item(null, 'tool_call') });
    await drain();
  };

  /** That call coming BACK — the same unit of work, reported a second time. */
  const toolResult = async (): Promise<void> => {
    items.next({ runId: 'run-a', item: item(null, 'tool_result') });
    await drain();
  };

  /** Two settles in a row, the second after the first has fully drained. */
  const settleTwice = async (): Promise<void> => {
    await settle();
    await settle();
  };

  /**
   * Two settles in the SAME tick — the only shape that reaches the in-flight
   * guard, since a serialized pair has already cleared it in `finally`.
   */
  const settleConcurrently = async (): Promise<void> => {
    items.next({ runId: 'run-a', item: item() });
    items.next({ runId: 'run-a', item: item() });
    await drain();
    await drain();
  };

  /** The run and everything it owned has been deleted. */
  const deleteRun = async (): Promise<void> => {
    deleted.next('run-a');
    await drain();
  };

  /** Move the service's clock past the early-naming cooldown. */
  const waitOutCooldown = (): void => {
    clock += 2 * 60_000;
  };

  return {
    settle,
    settleKind,
    userMessage,
    assistantMessage,
    toolCall,
    toolResult,
    waitOutCooldown,
    settleTwice,
    settleConcurrently,
    deleteRun,
    retitle,
    getByRunNode,
    statuses,
    readSessionTitle,
    generateTitle,
    adapterFor,
  };
}

describe('ChatTitleService', () => {
  it("prefers the CLI's own title over the derived one", async () => {
    const { settle, retitle, statuses } = build({
      nativeTitle: 'Fix Conflicts Worktree',
      firstUserMessageText:
        'can you look at the merge conflicts in the worktree',
    });

    await settle();

    expect(retitle).toHaveBeenCalledWith(
      'run-a',
      'Fix Conflicts Worktree',
      null,
      expect.anything(),
    );
    // No `activity` key at all: this announce never read the run, and a null
    // there clears the phrase of a turn that may already be running again.
    expect(statuses).toEqual([
      { runId: 'run-a', status: null, title: 'Fix Conflicts Worktree' },
    ]);
    expect(statuses[0]).not.toHaveProperty('activity');
  });

  it('asks the adapter with the session id node_state recorded', async () => {
    const { settle, readSessionTitle, adapterFor, getByRunNode } = build({
      nativeTitle: 'Grok Subagent Review',
    });

    await settle();

    // The wiring the loose fakes used to hide: a null id here answers null from
    // the real cursor adapter, so every cursor chat would quietly take the
    // derived path while all the other assertions stayed green.
    expect(readSessionTitle).toHaveBeenCalledWith('sess-1');
    expect(adapterFor).toHaveBeenCalledWith(AgentKind.CursorAgent);
    expect(getByRunNode).toHaveBeenCalledWith(
      'run-a',
      SINGLE_AGENT_NODE,
      expect.anything(),
    );
  });

  it('does not ask the adapter before the CLI has named a session', async () => {
    const { settle, readSessionTitle, retitle } = build({
      agentSessionId: null,
      firstUserMessageText: 'first turn of a brand-new chat',
    });

    await settle();

    expect(readSessionTitle).not.toHaveBeenCalled();
    expect(retitle).toHaveBeenCalledWith(
      'run-a',
      'first turn of a brand-new chat',
      null,
      expect.anything(),
    );
  });

  it('derives a title from the opening message when the CLI has none', async () => {
    const { settle, retitle } = build({
      nativeTitle: null,
      firstUserMessageText: 'add auto chat titles\n\nlike the cursor UI does',
    });

    await settle();

    expect(retitle).toHaveBeenCalledWith(
      'run-a',
      'add auto chat titles like the cursor UI does',
      null,
      expect.anything(),
    );
  });

  it('never overwrites a title the user chose', async () => {
    // The whole reason no `titleSource` column exists: an upgrade only replaces
    // a title that is still EXACTLY what this service would derive, and a name
    // the user typed is not.
    const { settle, retitle, statuses } = build({
      run: { title: 'My own name for this' },
      nativeTitle: 'Fix Conflicts Worktree',
      firstUserMessageText: 'whatever',
    });

    await settle();

    expect(retitle).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });

  it("upgrades its own derived title to the agent's once that lands", async () => {
    // Cursor names a conversation only after an exchange, so the first turn
    // routinely reads nothing and the derived title is written. Without this a
    // chat started in the app would keep that title for good and the agent's —
    // the whole point of asking the CLI — would only ever appear on an import.
    const { settle, retitle, statuses } = build({
      run: { title: 'look at the merge conflicts' },
      nativeTitle: 'Fix Conflicts Worktree',
      firstUserMessageText: 'look at the merge conflicts',
    });

    await settle();

    expect(retitle).toHaveBeenCalledWith(
      'run-a',
      'Fix Conflicts Worktree',
      // Conditional on the title it READ, so a rename racing the upgrade wins.
      'look at the merge conflicts',
      expect.anything(),
    );
    expect(statuses).toEqual([
      { runId: 'run-a', status: null, title: 'Fix Conflicts Worktree' },
    ]);
  });

  it('names a chat whose turn was STOPPED, from the name the CLI already wrote', async () => {
    // REPORTED as a cursor thread still titled by the first user message. The
    // naming fired on `turn_complete` alone, so a turn the user pressed Stop on
    // — or one that failed — left the chat wearing its opening line for good,
    // even though the CLI had written a name of its own by then.
    const { settleKind, retitle } = build({
      run: { title: 'look at the merge conflicts' },
      nativeTitle: 'Fix Conflicts Worktree',
      firstUserMessageText: 'look at the merge conflicts',
    });

    await settleKind('turn_cancelled');

    expect(retitle).toHaveBeenCalledWith(
      'run-a',
      'Fix Conflicts Worktree',
      'look at the merge conflicts',
      expect.anything(),
    );
  });

  it('does not spend a model call on a turn that FAILED', async () => {
    // The read is a file open and runs on every ending; the ask spawns a
    // process and bills a model call. A turn that died has nothing to name that
    // the derived title does not already say, so only the free route runs.
    const { settleKind, readSessionTitle, generateTitle, retitle } = build({
      run: { title: 'look at the merge conflicts' },
      nativeTitle: null,
      firstUserMessageText: 'look at the merge conflicts',
      generatedTitle: 'Should Not Be Asked For',
    });

    await settleKind('error');

    expect(readSessionTitle).toHaveBeenCalled();
    expect(generateTitle).not.toHaveBeenCalled();
    expect(retitle).not.toHaveBeenCalled();
  });

  it('stops re-asking once the agent has named the chat', async () => {
    const { settle, readSessionTitle, generateTitle, retitle } = build({
      run: { title: 'Fix Conflicts Worktree' },
      nativeTitle: 'Fix Conflicts Worktree',
      firstUserMessageText: 'look at the merge conflicts',
    });

    await settle();
    await settle();

    // A title that is not what this service would derive is not this service's
    // to replace — the agent's own name reads exactly like the user's own — so
    // it neither writes nor spends anything asking, on this turn or any later
    // one. That check comes first precisely so asking is not spent to find out.
    expect(retitle).not.toHaveBeenCalled();
    expect(readSessionTitle).not.toHaveBeenCalled();
    expect(generateTitle).not.toHaveBeenCalled();
  });

  it('forgets a deleted run rather than holding its counter forever', async () => {
    // The per-run map outlives the operation that writes it, so it needs its
    // own teardown — a map cleared only at the next turn's start is exactly the
    // shape that leaks on delete. Observed through the counter: a run whose
    // entry survived the delete would have no attempts left to spend.
    const { settle, deleteRun, readSessionTitle } = build({
      run: { title: 'add auto chat titles' },
      nativeTitle: null,
      firstUserMessageText: 'add auto chat titles',
    });

    for (let turn = 0; turn < 5; turn += 1) {
      await settle();
    }
    expect(readSessionTitle).toHaveBeenCalledTimes(5);

    await deleteRun();
    await settle();

    expect(readSessionTitle).toHaveBeenCalledTimes(6);
  });

  it('gives up re-asking a CLI that never names anything', async () => {
    // Claude writes no title at all headlessly, so an unbounded upgrade would
    // be a database read on every turn of every claude chat, forever.
    const { settle, readSessionTitle } = build({
      run: { title: 'add auto chat titles' },
      nativeTitle: null,
      firstUserMessageText: 'add auto chat titles',
    });

    for (let turn = 0; turn < 8; turn += 1) {
      await settle();
    }

    expect(readSessionTitle).toHaveBeenCalledTimes(5);
  });

  it('ASKS the CLI to name a chat whose store holds no title', async () => {
    // The reported defect, end to end: headless claude writes no title
    // anywhere, so a chat opened with a pasted URL was named after that URL for
    // good. Reading finds nothing and the ask is what produces a real name.
    const { settle, retitle, generateTitle, statuses } = build({
      run: { title: 'https://ticktick.com/webapp/#p/699/tasks/6a8 do this' },
      nativeTitle: null,
      firstUserMessageText:
        'https://ticktick.com/webapp/#p/699/tasks/6a8 do this',
      firstAssistantMessageText: 'I will start by fetching the TickTick task.',
      generatedTitle: 'Implement TickTick task with screenshots',
    });

    await settle();

    // It is asked about the EXCHANGE — the opening line names nothing on its
    // own, which is exactly the shape that got reported.
    expect(generateTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        opening: 'https://ticktick.com/webapp/#p/699/tasks/6a8 do this',
        reply: 'I will start by fetching the TickTick task.',
      }),
    );
    expect(retitle).toHaveBeenCalledWith(
      'run-a',
      'Implement TickTick task with screenshots',
      'https://ticktick.com/webapp/#p/699/tasks/6a8 do this',
      expect.anything(),
    );
    expect(statuses.at(-1)?.title).toBe(
      'Implement TickTick task with screenshots',
    );
  });

  it('re-asks across later turns, then stops — bounded by the read budget', async () => {
    // Asking spawns a process and bills a model call, so a chat nobody can
    // name must stop costing one. But asking ONCE was wrong, which is the
    // reported "we fixed it twice and the title still is not set": an opening
    // that is a bare link has nothing nameable in it (measured on 2.1.237 —
    // the naming turn answers "I need to see the Slack thread…"), so the first
    // ask can only be declined and the chat wore its opening line for good.
    const { settle, generateTitle, readSessionTitle } = build({
      run: { title: 'https://slack/x' },
      nativeTitle: null,
      firstUserMessageText: 'https://slack/x',
      generatedTitle: null,
    });

    for (let turn = 0; turn < 8; turn += 1) {
      await settle();
    }

    expect(generateTitle).toHaveBeenCalledTimes(CHAT_TITLE_UPGRADE_TURNS);
    expect(readSessionTitle).toHaveBeenCalledTimes(CHAT_TITLE_UPGRADE_TURNS);
  });

  it('gives a LATER ask what the conversation has since said', async () => {
    // The whole reason a retry is worth making: the same two messages would
    // reproduce the same refusal. The first ask carries no `latest`, because
    // there is nothing later than the opening yet.
    const { settle, generateTitle } = build({
      run: { title: 'https://slack/x' },
      nativeTitle: null,
      firstUserMessageText: 'https://slack/x',
      generatedTitle: null,
    });

    await settle();
    expect(generateTitle.mock.calls[0]?.[0]).toMatchObject({ latest: null });

    await settle();
    expect(generateTitle.mock.calls[1]?.[0]?.latest).not.toBeNull();
  });

  it('does not ask when the CLI already wrote a title of its own', async () => {
    // The cheap route wins: cursor names its own conversations, and spending a
    // model call to re-answer a question already answered is the whole of what
    // the ordering here is for.
    const { settle, retitle, generateTitle } = build({
      run: { title: 'look at the merge conflicts' },
      nativeTitle: 'Fix Conflicts Worktree',
      firstUserMessageText: 'look at the merge conflicts',
    });

    await settle();

    expect(generateTitle).not.toHaveBeenCalled();
    expect(retitle).toHaveBeenCalledWith(
      'run-a',
      'Fix Conflicts Worktree',
      'look at the merge conflicts',
      expect.anything(),
    );
  });

  it('keeps the derived title when the ask fails', async () => {
    const { settle, retitle } = build({
      run: { title: 'add auto chat titles' },
      nativeTitle: null,
      firstUserMessageText: 'add auto chat titles',
      generatedTitle: null,
    });

    await settle();

    expect(retitle).not.toHaveBeenCalled();
  });

  it('leaves a workflow run to its workflow label', async () => {
    const { settle, retitle } = build({
      run: { workflowId: 'wf-1' },
      firstUserMessageText: 'the first node prompt',
    });

    await settle();

    expect(retitle).not.toHaveBeenCalled();
  });

  it('ignores a graph node’s turn without reading the run at all', async () => {
    const { settle, retitle, readSessionTitle } = build({
      nativeTitle: 'Should Not Be Used',
    });

    await settle('node-1');

    expect(retitle).not.toHaveBeenCalled();
    expect(readSessionTitle).not.toHaveBeenCalled();
  });

  it('leaves a run unnamed when there is nothing to name it after', async () => {
    const { settle, retitle, statuses } = build({
      nativeTitle: null,
      firstUserMessageText: null,
    });

    await settle();

    expect(retitle).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });

  it('falls back to the derived title when the adapter throws', async () => {
    // A CLI read that fails must cost the chat its NATIVE title, never its
    // title — the daemon's turn plumbing is downstream of this subscriber.
    const { settle, retitle } = build({
      readSessionTitle: vi.fn().mockRejectedValue(new Error('store locked')),
      firstUserMessageText: 'still gets a name',
    });

    await settle();

    expect(retitle).toHaveBeenCalledWith(
      'run-a',
      'still gets a name',
      null,
      expect.anything(),
    );
  });

  it('caps a long derived title rather than storing the whole message', async () => {
    const { settle, retitle } = build({
      nativeTitle: null,
      firstUserMessageText: 'x'.repeat(500),
    });

    await settle();

    const title = retitle.mock.calls[0]?.[1] as string;
    expect(title).toHaveLength(60);
    expect(title.endsWith('…')).toBe(true);
  });

  it('does not name a run it cannot find', async () => {
    const { settle, retitle } = build({ run: null });

    await settle();

    expect(retitle).not.toHaveBeenCalled();
  });

  it('does not re-name a run whose title the first settle wrote', async () => {
    // The CLI carrying on after its own result line settles the run a second
    // time — `handleBetweenTurnEvent` deliberately allows it. The two are
    // SERIALIZED here, so what this pins is the already-named exit rather than
    // the in-flight guard; the concurrent case below covers that one.
    const { settleTwice, retitle } = build({
      nativeTitle: 'Named Once',
    });

    await settleTwice();

    expect(retitle).toHaveBeenCalledTimes(1);
  });

  it('names a run once when two settles arrive in the same tick', async () => {
    // The in-flight guard's own case: both events are published before either
    // naming has drained, so the second finds the first still resolving — the
    // row it would read has not been written yet, and only the Set stops it.
    const { settleConcurrently, retitle } = build({
      nativeTitle: 'Named Once',
    });

    await settleConcurrently();

    expect(retitle).toHaveBeenCalledTimes(1);
  });

  it('withholds the announce when the claim loses to a rename', async () => {
    // The lost-claim branch: the row is renamed while the title is being
    // resolved, so the conditional write reports back that this call is not
    // what named the run — and a title that lost must not be broadcast either,
    // or the sidebar shows a name the database does not hold.
    const { settle, retitle, statuses } = build({
      nativeTitle: 'Auto Generated',
      renameDuringResolve: 'The name I typed',
    });

    await settle();

    expect(retitle).toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });

  it('ignores a message that is not the USER’s', async () => {
    // The two kinds this service acts on are a settled turn and the user's own
    // message; an agent's message is neither, and reading a session title per
    // streamed reply would be a read per row.
    const { settleKind, retitle, readSessionTitle } = build({
      nativeTitle: 'Should Not Be Used',
    });

    await settleKind('message');

    expect(readSessionTitle).not.toHaveBeenCalled();
    expect(retitle).not.toHaveBeenCalled();
  });

  it('names the chat from the user’s first message, before any turn ends', async () => {
    // REPORTED as "AutoTitle не работает — просто название агента выводит",
    // against a sidebar row reading `claude` under a turn still running. An
    // untitled run falls through to its agent kind, and naming fired on
    // `turn_complete` alone — so every new chat was labelled after its CLI for
    // the whole of its first turn.
    const { userMessage, retitle, statuses } = build({
      firstUserMessageText: 'why does the worktree switch fail',
    });

    await userMessage();

    expect(retitle).toHaveBeenCalledWith(
      'run-a',
      'why does the worktree switch fail',
      null,
      expect.anything(),
    );
    // Broadcast, so the sidebar row renames itself without a refetch.
    expect(statuses).toEqual([
      expect.objectContaining({ title: 'why does the worktree switch fail' }),
    ]);
  });

  it('leaves an already-named run alone on every later message', async () => {
    // The message path names an UNNAMED run and stops. Reaching `upgrade` from
    // here would spend the run's few attempts — and a session read apiece — on
    // every message the user ever sends.
    const { userMessage, retitle, readSessionTitle } = build({
      run: { title: 'A name it already has' },
      nativeTitle: 'Should Not Be Used',
      firstUserMessageText: 'a later question',
    });

    await userMessage();

    expect(readSessionTitle).not.toHaveBeenCalled();
    expect(retitle).not.toHaveBeenCalled();
  });

  it('leaves a run with no agent kind alone', async () => {
    const { settle, retitle, readSessionTitle } = build({
      run: { agentKind: null },
      firstUserMessageText: 'an imported row with no agent',
    });

    await settle();

    expect(readSessionTitle).not.toHaveBeenCalled();
    expect(retitle).not.toHaveBeenCalled();
  });

  it('writes nothing when the opening message is only whitespace', async () => {
    // Reduces to the empty string rather than to null, which is a different
    // path through `resolve` than "no message at all".
    const { settle, retitle, statuses } = build({
      nativeTitle: null,
      firstUserMessageText: '   \n\t ',
    });

    await settle();

    expect(retitle).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });
});

describe('naming while the turn is still running', () => {
  it("upgrades on the agent's FIRST words, without waiting for the turn to end", async () => {
    // The report, three times over. Measured on the reporter's own geniro.db:
    // every COMPLETED chat carried a generated name and every RUNNING one still
    // wore its raw prompt, because the upgrade fired on `turn_complete` alone —
    // and these turns run for hours, which is the whole window somebody is
    // looking at the sidebar in.
    const { assistantMessage, retitle, statuses } = build({
      run: { title: 'can you look at the merge conflicts in the worktree' },
      firstUserMessageText:
        'can you look at the merge conflicts in the worktree',
      nativeTitle: 'Fix Conflicts Worktree',
    });

    await assistantMessage();

    // No settle anywhere above: remove the assistant-message branch and this is
    // zero calls, which is the state that got reported.
    expect(retitle).toHaveBeenCalledWith(
      'run-a',
      'Fix Conflicts Worktree',
      'can you look at the merge conflicts in the worktree',
      expect.anything(),
    );
    expect(statuses.at(-1)?.title).toBe('Fix Conflicts Worktree');
  });

  it('upgrades when the agent WORKS without talking, on its first tool call', async () => {
    // REPORTED a fourth time as "It didnt change the thread title", over a chat
    // 1m 47s into its first turn whose transcript read `Read 1 file · ran 11
    // commands` with no assistant message anywhere. A tool-led opening is the
    // norm on the work this app is for, so gating the early naming on the agent
    // TALKING left exactly the long turns — the ones somebody is hunting for in
    // the sidebar — on their raw opening line for the whole duration.
    const { toolCall, retitle, statuses } = build({
      run: { title: 'can you look at the merge conflicts in the worktree' },
      firstUserMessageText:
        'can you look at the merge conflicts in the worktree',
      nativeTitle: 'Fix Conflicts Worktree',
    });

    await toolCall();

    // No settle and no assistant message anywhere above: narrow the trigger back
    // to an assistant message and this is zero calls, which is what was reported.
    expect(retitle).toHaveBeenCalledWith(
      'run-a',
      'Fix Conflicts Worktree',
      'can you look at the merge conflicts in the worktree',
      expect.anything(),
    );
    expect(statuses.at(-1)?.title).toBe('Fix Conflicts Worktree');
  });

  it('does NOT re-trigger on a tool RESULT, which is the same work reported twice', async () => {
    // The trigger is deliberately narrow. A call and its result are one unit of
    // work, so counting both would spend two of the run's attempts on one
    // action and halve what the cooldown is holding back.
    const { toolCall, toolResult, retitle } = build({
      run: { title: 'look at the merge conflicts' },
      firstUserMessageText: 'look at the merge conflicts',
      nativeTitle: null,
    });

    await toolCall();
    const afterCall = retitle.mock.calls.length;
    await toolResult();

    expect(retitle.mock.calls.length).toBe(afterCall);
  });

  it('asks once per cooldown, however many messages the agent writes', async () => {
    // A `-p` turn per paragraph is what the cooldown prevents. The CLI is
    // unable to name it here, so nothing retires the budget — the cooldown is
    // the only thing holding the line.
    const {
      assistantMessage,
      waitOutCooldown,
      readSessionTitle,
      generateTitle,
    } = build({
      run: { agentKind: AgentKind.Claude, title: 'fix the flaky spec' },
      firstUserMessageText: 'fix the flaky spec',
      nativeTitle: null,
      generatedTitle: null,
    });

    await assistantMessage();
    await assistantMessage();
    await assistantMessage();

    expect(readSessionTitle).toHaveBeenCalledTimes(1);
    expect(generateTitle).toHaveBeenCalledTimes(1);

    // …and it is a COOLDOWN, not a one-shot: a long turn gets another go, which
    // is the whole point on work that runs for hours.
    waitOutCooldown();
    await assistantMessage();

    expect(generateTitle).toHaveBeenCalledTimes(2);
  });

  it('retries a DECLINED early ask later in the same turn', async () => {
    // Measured in the running app: the agent's first words at 12:51:33, the ask
    // declined at 12:51:54, and the same exchange put to the same model by hand
    // answering a perfectly good title. One shot would have left the raw prompt
    // standing for the rest of the turn on nothing but that variance.
    const { assistantMessage, waitOutCooldown, retitle } = build({
      run: { title: 'fix the flaky spec' },
      firstUserMessageText: 'fix the flaky spec',
      readSessionTitle: vi
        .fn<() => Promise<string | null>>()
        .mockResolvedValueOnce(null)
        .mockResolvedValue('Stabilise Flaky Timer Spec'),
    });

    await assistantMessage();
    expect(retitle).not.toHaveBeenCalled();

    waitOutCooldown();
    await assistantMessage();

    // No settle anywhere: the turn is still running, which is the case that had
    // no naming at all before this.
    expect(retitle).toHaveBeenCalledWith(
      'run-a',
      'Stabilise Flaky Timer Spec',
      'fix the flaky spec',
      expect.anything(),
    );
  });

  it('leaves the ending free to try again when the early attempt found nothing', async () => {
    // The early moment is an ADDITION, not a replacement: they share one per-run
    // budget, so an agent that could not be named yet is still named at the end.
    const { assistantMessage, settle, retitle } = build({
      run: { title: 'fix the flaky spec' },
      firstUserMessageText: 'fix the flaky spec',
      readSessionTitle: vi
        .fn<() => Promise<string | null>>()
        .mockResolvedValueOnce(null)
        .mockResolvedValue('Stabilise Flaky Timer Spec'),
    });

    await assistantMessage();
    expect(retitle).not.toHaveBeenCalled();

    await settle();

    expect(retitle).toHaveBeenCalledWith(
      'run-a',
      'Stabilise Flaky Timer Spec',
      'fix the flaky spec',
      expect.anything(),
    );
  });

  it('does not name an UNTITLED run from the agent, only from the user', async () => {
    // A run with no title has not had its opening message yet (the user branch
    // names it the moment that lands), so an agent message reaching `resolve`
    // would name the chat after whatever the CLI happened to answer. Asserted
    // through the derived path: with no user message there is nothing to derive.
    const { assistantMessage, retitle } = build({
      run: { title: null },
      firstUserMessageText: null,
      nativeTitle: null,
    });

    await assistantMessage();

    expect(retitle).not.toHaveBeenCalled();
  });
});
