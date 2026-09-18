import { describe, expect, it, vi } from 'vitest';

import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ItemKind } from '../../runs/runs.types';
import { errorOf } from '../__tests__/call-envelope';
import type {
  CalleeTurnOutcome,
  RunCallCapability,
  RunCallSeed,
  WorkflowAgentNode,
} from '../graphs.types';
import { CallBroker } from './call-broker.service';

const HELPER: WorkflowAgentNode = {
  id: 'helper',
  kind: 'agent',
  name: 'Helper',
  agent: 'claude',
  approval: 'auto',
  role: 'You help.',
};

const WRITER: WorkflowAgentNode = {
  id: 'writer',
  kind: 'agent',
  agent: 'claude',
  approval: 'auto',
};

interface RecordedItem {
  nodeId: string | null;
  kind: ItemKind;
  payload: Record<string, unknown>;
}

interface Deferred {
  resolve: (outcome: CalleeTurnOutcome) => void;
}

function harness(options?: {
  calleesOf?: Map<string, WorkflowAgentNode[]>;
  cancelled?: boolean;
  /** 'defer' keeps every launch pending until resolved by the test. */
  launch?: 'instant' | 'defer' | 'throw';
  /** Node-liveness override; default: every node has a live turn. */
  isNodeLive?: (nodeId: string) => boolean;
  /** Instant turns record no resumable session (thread continuation off). */
  noSession?: boolean;
  /** Whether a caller can be woken; default: never (the pre-wake behaviour). */
  wakeNode?: (nodeId: string, prompt: string) => boolean;
  /** Whether a working caller takes a message; default: never. */
  tellLiveNode?: (nodeId: string, prompt: string) => boolean;
  /** What an earlier daemon's pass of the run left in the transcript. */
  seed?: RunCallSeed;
}): {
  broker: CallBroker;
  capability: RunCallCapability;
  items: RecordedItem[];
  launches: {
    callee: WorkflowAgentNode;
    message: string;
    callId: string;
    resumeSessionId: string | null;
    conversationId: string;
  }[];
  deferred: Deferred[];
} {
  const items: RecordedItem[] = [];
  const launches: {
    callee: WorkflowAgentNode;
    message: string;
    callId: string;
    resumeSessionId: string | null;
    conversationId: string;
  }[] = [];
  const deferred: Deferred[] = [];
  const mode = options?.launch ?? 'instant';
  const capability: RunCallCapability = {
    calleesOf: options?.calleesOf ?? new Map([['orch', [HELPER, WRITER]]]),
    launchCalleeTurn: (
      callee,
      message,
      callId,
      _depth,
      resumeSessionId,
      conversationId,
    ) => {
      launches.push({
        callee,
        message,
        callId,
        resumeSessionId,
        conversationId,
      });
      if (mode === 'throw') {
        return Promise.reject(new Error('spawn exploded'));
      }
      if (mode === 'defer') {
        return new Promise<CalleeTurnOutcome>((resolve) => {
          deferred.push({ resolve });
        });
      }
      return Promise.resolve({
        status: 'completed',
        finalText: `done by ${callee.id}`,
        error: null,
        sessionId: options?.noSession ? null : `sess-${callId}`,
      });
    },
    persistItem: (nodeId, kind, _role, payload) => {
      items.push({
        nodeId,
        kind,
        payload: payload as Record<string, unknown>,
      });
    },
    isCancelled: () => options?.cancelled ?? false,
    isNodeLive: options?.isNodeLive ?? (() => true),
    wakeNode: options?.wakeNode ?? (() => false),
    tellLiveNode: options?.tellLiveNode ?? (() => false),
  };
  const broker = new CallBroker();
  broker.registerRun('run-1', capability, options?.seed ?? null);
  return { broker, capability, items, launches, deferred };
}

describe('CallBroker', () => {
  it('sync call: launches the callee and returns its text in an ok envelope', async () => {
    const { broker, items, launches } = harness();
    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'summarize X',
    });
    expect(envelope).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'done by helper' },
    });
    expect(launches).toEqual([
      {
        callee: HELPER,
        message: 'summarize X',
        callId: 'call-1',
        resumeSessionId: null,
        conversationId: 'call-1',
      },
    ]);
    // Transcript: call_started then call_result, both on the CALLER's node.
    expect(items.map((i) => [i.kind, i.nodeId])).toEqual([
      ['call_started', 'orch'],
      ['call_result', 'orch'],
    ]);
    expect(items[0]!.payload).toMatchObject({
      callId: 'call-1',
      calleeNodeId: 'helper',
      mode: 'sync',
      message: 'summarize X',
    });
    expect(items[1]!.payload).toMatchObject({
      callId: 'call-1',
      status: 'ok',
      // The settled thread's CLI session rides the call_result item — the
      // UI's handle for opening a terminal on THIS thread.
      sessionId: 'sess-call-1',
    });
  });

  it('carries the caller’s title onto the call_started item', async () => {
    const { broker, items } = harness();
    await broker.callAgent('run-1', 'orch', {
      agent: 'helper',
      message: 'summarize X',
      title: 'Get concrete UAT links from the DB',
    });
    const started = items.find((i) => i.kind === 'call_started')!;
    expect(started.payload.title).toBe('Get concrete UAT links from the DB');
  });

  it('resolves the callee by display name and refuses names off the call wiring', async () => {
    const { broker } = harness();
    const byName = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'Helper',
      message: 'm',
    });
    expect(byName.status).toBe('ok');
    const unknown = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'stranger',
      message: 'm',
    });
    expect(unknown.status).toBe('error');
    expect(errorOf(unknown)).toContain('UNKNOWN_AGENT');
    expect(errorOf(unknown)).toContain('Helper'); // the wired list is named back
  });

  it('an ambiguous display name resolves nothing instead of guessing', async () => {
    const twin: WorkflowAgentNode = { ...WRITER, id: 'writer-2', name: 'Twin' };
    const twin2: WorkflowAgentNode = {
      ...WRITER,
      id: 'writer-3',
      name: 'Twin',
    };
    const { broker } = harness({
      calleesOf: new Map([['orch', [twin, twin2]]]),
    });
    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'Twin',
      message: 'm',
    });
    expect(envelope.status).toBe('error');
    expect(errorOf(envelope)).toContain('UNKNOWN_AGENT');
    // The exact id still works.
    const byId = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'writer-2',
      message: 'm',
    });
    expect(byId.status).toBe('ok');
  });

  it('a caller with no call edges gets UNKNOWN_AGENT (callable: none)', async () => {
    const { broker } = harness();
    const envelope = await broker.callAgent('run-1', 'lonely', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    expect(envelope.status).toBe('error');
    expect(errorOf(envelope)).toContain('callable: none');
  });

  it('async call returns a call_id at once; await_agent collects exactly once', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    const started = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    expect(started).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', state: 'started' },
    });
    const awaiting = broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'async done',
      error: null,
      sessionId: null,
    });
    const collected = await awaiting;
    expect(collected).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'async done' },
    });
    expect(items.map((i) => i.kind)).toEqual([
      'call_started',
      'call_result',
      'await_collected',
    ]);
    // A second collect finds nothing — the result was consumed.
    const again = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(errorOf(again)).toContain('UNKNOWN_CALL');
  });

  it('an ABANDONED collection consumes nothing — the retry still gets the result', async () => {
    // MEASURED on the reporter's own run: the claude CLI aborted its own
    // `await_agent` fetch after 338s, the callee finished 28s later ($7.03 of
    // work), the broker consumed the entry into that dead request — writing
    // `await_collected` — and the retry was told UNKNOWN_CALL. The turn was
    // then unreachable for the rest of the run and the caller re-issued the
    // whole call from scratch.
    const { broker, items, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const gone = new AbortController();
    const abandoned = broker.awaitAgent(
      'run-1',
      'orch',
      { call_id: 'call-1' },
      gone.signal,
    );
    gone.abort(); // the request's socket closes while the callee works on
    expect(errorOf(await abandoned)).toContain('AWAIT_ABANDONED');

    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'async done',
      error: null,
      sessionId: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Nothing was collected, so nothing was written — the entry is intact.
    expect(items.map((i) => i.kind)).toEqual(['call_started', 'call_result']);
    const retry = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(retry).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'async done' },
    });
    expect(items.map((i) => i.kind)).toContain('await_collected');
  });

  it('a timed-out collection answers pending and consumes nothing — the caller comes back for it', async () => {
    // The whole point of the argument: a caller that does not want to block for
    // the callee's full run can stop waiting and go do something else, and the
    // work is still there when it returns. `pending` rather than an error,
    // because nothing went wrong — an error arm here is what would have a model
    // abandon or re-issue a call that is running perfectly well.
    const { broker, items, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    expect(
      await broker.awaitAgent('run-1', 'orch', {
        call_id: 'call-1',
        timeout_ms: 1,
      }),
    ).toEqual({ status: 'pending', call_id: 'call-1', agent: 'helper' });
    // Nothing consumed: no receipt, and the entry is still the caller's.
    expect(items.map((i) => i.kind)).toEqual(['call_started']);

    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'the build passed',
      error: null,
      sessionId: null,
    });
    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' }),
    ).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'the build passed' },
    });
    expect(items.map((i) => i.kind)).toContain('await_collected');
  });

  it('a window the callee finishes inside returns the RESULT, not pending', async () => {
    // The other half of the same argument, and the one a deadline written as a
    // plain race would break: the timer must not win over an outcome that is
    // already there, or every bounded await would report `pending` about a
    // callee that had answered.
    const { broker } = harness();
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    expect(
      await broker.awaitAgent('run-1', 'orch', {
        call_id: 'call-1',
        timeout_ms: 60_000,
      }),
    ).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'done by helper' },
    });
  });

  it('an ABANDONED request outranks its own deadline', async () => {
    // Both races can be won in the same tick, and they mean opposite things:
    // `pending` is an answer to somebody, and there is nobody left to give it
    // to. Reporting it into a dead socket would also be the one shape that
    // looks, from the outside, exactly like the abandonment bug being back.
    const { broker, items, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const gone = new AbortController();
    const abandoned = broker.awaitAgent(
      'run-1',
      'orch',
      { call_id: 'call-1', timeout_ms: 1 },
      gone.signal,
    );
    gone.abort();
    expect(errorOf(await abandoned)).toContain('AWAIT_ABANDONED');
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'done',
      error: null,
      sessionId: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(items.map((i) => i.kind)).not.toContain('await_collected');
  });

  it('a collection abandoned AFTER the callee settled still leaves it collectable', async () => {
    // The race the fix is really about: the outcome and the abort land in the
    // same tick, so a check written only at entry would sail past it and
    // consume anyway.
    const { broker, items, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const gone = new AbortController();
    const abandoned = broker.awaitAgent(
      'run-1',
      'orch',
      { call_id: 'call-1' },
      gone.signal,
    );
    gone.abort();
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'async done',
      error: null,
      sessionId: null,
    });
    await abandoned;
    await new Promise((resolve) => setImmediate(resolve));
    expect(items.map((i) => i.kind)).not.toContain('await_collected');
    expect(
      (await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' })).status,
    ).toBe('ok');
  });

  it('two concurrent await_agent waiters on one async call still collect exactly once', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    // The caller awaits the same call twice in parallel (a batched pair of
    // await_agent tool calls, or a client-side MCP timeout retry while the
    // first await is still blocked server-side). Collection must stay
    // exactly-once — the same contract the sequential re-await already gets
    // (UNKNOWN_CALL: "no un-collected async call").
    const first = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    const second = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'async done',
      error: null,
      sessionId: null,
    });
    const envelopes = await Promise.all([first, second]);
    const okCount = envelopes.filter((e) => e.status === 'ok').length;
    const unknownCount = envelopes.filter(
      (e) => e.status === 'error' && e.error.includes('UNKNOWN_CALL'),
    ).length;
    // One waiter collects the result; the other is told the call is no
    // longer un-collected — never two fresh collections of one result.
    expect(okCount).toBe(1);
    expect(unknownCount).toBe(1);
    // The transcript records the collection once, not once per waiter.
    expect(items.filter((i) => i.kind === 'await_collected')).toHaveLength(1);
  });

  it("await_agent refuses another caller's call id", async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const stolen = await broker.awaitAgent('run-1', 'writer', {
      call_id: 'call-1',
    });
    expect(errorOf(stolen)).toContain('UNKNOWN_CALL');
    deferred[0]!.resolve({
      status: 'completed',
      finalText: '',
      error: null,
      sessionId: null,
    });
  });

  it('fire_and_forget detaches: transcript only, never awaitable', async () => {
    const { broker, items } = harness();
    const detached = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'fire_and_forget',
    });
    expect(detached).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', state: 'detached' },
    });
    // The instant capability already settled the turn — after the microtask
    // chain drains, the result is on the transcript record.
    await new Promise((resolve) => setImmediate(resolve));
    expect(items.map((i) => i.kind)).toContain('call_result');
    const collected = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(errorOf(collected)).toContain('UNKNOWN_CALL');
  });

  it('caps the call chain at depth 3', async () => {
    // a→b→c→d is depth 3 (legal); d calling e would be depth 4.
    const node = (id: string): WorkflowAgentNode => ({
      id,
      kind: 'agent',
      agent: 'claude',
      approval: 'auto',
    });
    const { broker, deferred } = harness({
      launch: 'defer',
      calleesOf: new Map([
        ['a', [node('b')]],
        ['b', [node('c')]],
        ['c', [node('d')]],
        ['d', [node('e')]],
      ]),
    });
    const p1 = broker.callAgent('run-1', 'a', {
      title: 'why',
      agent: 'b',
      message: 'm',
    });
    const p2 = broker.callAgent('run-1', 'b', {
      title: 'why',
      agent: 'c',
      message: 'm',
    });
    const p3 = broker.callAgent('run-1', 'c', {
      title: 'why',
      agent: 'd',
      message: 'm',
    });
    const refused = await broker.callAgent('run-1', 'd', {
      title: 'why',
      agent: 'e',
      message: 'm',
    });
    expect(refused.status).toBe('error');
    expect(errorOf(refused)).toContain('DEPTH_LIMIT');
    for (const d of deferred) {
      d.resolve({
        status: 'completed',
        finalText: '',
        error: null,
        sessionId: null,
      });
    }
    await Promise.all([p1, p2, p3]);
  });

  it('caps total callee turns per run', async () => {
    const { broker } = harness();
    for (let i = 0; i < 50; i++) {
      const envelope = await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: `call ${i}`,
        mode: 'fire_and_forget',
      });
      expect(envelope.status).toBe('ok');
    }
    const over = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'one too many',
    });
    expect(over.status).toBe('error');
    expect(errorOf(over)).toContain('TURN_LIMIT');
  });

  it('maps callee failure and cancellation into error envelopes', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const failing = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    deferred[0]!.resolve({
      status: 'failed',
      finalText: null,
      error: 'exit 1',
      sessionId: null,
    });
    expect(errorOf(await failing)).toContain('CALLEE_FAILED: exit 1');

    const cancelled = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    deferred[1]!.resolve({
      status: 'cancelled',
      finalText: null,
      error: 'run cancelled',
      sessionId: null,
    });
    expect(errorOf(await cancelled)).toContain('CALLEE_CANCELLED');
  });

  it('wraps a throwing launch in CALL_FAILED instead of rejecting', async () => {
    const { broker } = harness({ launch: 'throw' });
    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    expect(envelope.status).toBe('error');
    expect(errorOf(envelope)).toContain('CALL_FAILED: spawn exploded');
  });

  it('refuses calls for unregistered runs and cancelled runs', async () => {
    const { broker } = harness({ cancelled: true });
    const cancelled = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    expect(errorOf(cancelled)).toContain('RUN_CANCELLED');

    broker.unregisterRun('run-1');
    expect(broker.hasRun('run-1')).toBe(false);
    const gone = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    expect(errorOf(gone)).toContain('RUN_NOT_ACTIVE');
    const goneAwait = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(errorOf(goneAwait)).toContain('RUN_NOT_ACTIVE');
  });

  it('drops a run\u2019s state when the RUN is destroyed, off the bus', () => {
    // The executor unregisters on its own delete; this covers the purge it
    // never sees — the retention sweep, which destroys an archived workflow run
    // from the module BELOW this one and can only announce it. Without the
    // subscription a swept run left its capability, its uncollected results and
    // any parked question's timer behind for the life of the daemon.
    const bus = new AgentEventBus();
    const broker = new CallBroker(bus);
    broker.onModuleInit();
    broker.registerRun('run-1', harness().capability);
    expect(broker.hasRun('run-1')).toBe(true);

    bus.publishRunDeleted('run-1');

    expect(broker.hasRun('run-1')).toBe(false);
  });

  it('listCallees exposes the wiring the tool description advertises', () => {
    const { broker } = harness();
    expect(broker.listCallees('run-1', 'orch').map((c) => c.id)).toEqual([
      'helper',
      'writer',
    ]);
    expect(broker.listCallees('run-1', 'nobody')).toEqual([]);
    expect(broker.listCallees('run-9', 'orch')).toEqual([]);
  });
});

describe('CallBroker — parked questions (M4)', () => {
  function park(
    broker: CallBroker,
    overrides: {
      callId?: string;
      ttlMs?: number;
      deliver?: (answer: string) => boolean;
      fail?: () => void;
    } = {},
  ): { delivered: string[]; failed: { count: number } } {
    const delivered: string[] = [];
    const failed = { count: 0 };
    const parked = broker.parkQuestion('run-1', overrides.callId ?? 'call-1', {
      question: 'Which color?',
      options: ['Red', 'Blue'],
      payload: { questions: [{ question: 'Which color?' }] },
      ttlMs: overrides.ttlMs,
      deliver:
        overrides.deliver ??
        ((answer) => {
          delivered.push(answer);
          return true;
        }),
      fail:
        overrides.fail ??
        (() => {
          failed.count += 1;
        }),
    });
    expect(parked).toBe(true);
    return { delivered, failed };
  }

  it('a sync call parks: the caller gets the question envelope early, answers, and collects the final result via await_agent', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    const sync = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const { delivered } = park(broker);
    expect(await sync).toEqual({
      status: 'question',
      call_id: 'call-1',
      agent: 'helper',
      question: 'Which color?',
      options: ['Red', 'Blue'],
    });
    const answered = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'Blue',
    });
    expect(answered).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', state: 'answered' },
    });
    expect(delivered).toEqual(['Blue']);
    const awaiting = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'chose blue',
      error: null,
      sessionId: null,
    });
    expect(await awaiting).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'chose blue' },
    });
    expect(items.map((i) => i.kind)).toEqual([
      'call_started',
      'call_question',
      'call_answer',
      'call_result',
      'await_collected',
    ]);
    expect(items[1]!.payload).toMatchObject({
      callId: 'call-1',
      callerNodeId: 'orch',
      calleeNodeId: 'helper',
      question: 'Which color?',
      options: ['Red', 'Blue'],
      payload: { questions: [{ question: 'Which color?' }] },
    });
    expect(items[2]!.payload).toMatchObject({
      answer: 'Blue',
      outcome: 'answered',
    });
  });

  it('await_agent diverts to the question envelope WITHOUT consuming the call — a later await collects the final', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    // The await is already blocking when the question parks — it must divert.
    const awaiting = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    park(broker);
    const question = await awaiting;
    expect(question.status).toBe('question');
    broker.answerAgent('run-1', 'orch', { call_id: 'call-1', answer: 'Red' });
    const second = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'ok',
      error: null,
      sessionId: null,
    });
    expect((await second).status).toBe('ok');
  });

  it('a question from ANOTHER call reaches a caller blocked awaiting a different call, and both calls stay collectable', async () => {
    // Run 51c646fb: the Manager sat in await_agent(call-5) while call-7's
    // callee asked it something; only an await on call-7 could deliver it, so
    // the question expired five minutes later as QUESTION_TIMEOUT.
    const { broker, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'writer',
      message: 'm',
      mode: 'async',
    });
    const awaitingFirst = broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    park(broker, { callId: 'call-2' });
    expect(await awaitingFirst).toEqual({
      status: 'question',
      call_id: 'call-2',
      agent: 'writer',
      question: 'Which color?',
      options: ['Red', 'Blue'],
      still_running: 'call-1',
    });
    expect(
      broker.answerAgent('run-1', 'orch', { call_id: 'call-2', answer: 'Red' })
        .status,
    ).toBe('ok');
    const first = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'one',
      error: null,
      sessionId: null,
    });
    expect((await first).status).toBe('ok');
    const second = broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' });
    deferred[1]!.resolve({
      status: 'completed',
      finalText: 'two',
      error: null,
      sessionId: null,
    });
    expect((await second).status).toBe('ok');
  });

  it('a sync call whose wait is diverted by another call’s question becomes await-collectable', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const sync = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'writer',
      message: 'm',
    });
    park(broker, { callId: 'call-1' });
    expect(await sync).toMatchObject({
      status: 'question',
      call_id: 'call-1',
      still_running: 'call-2',
    });
    const collected = broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-2',
    });
    deferred[1]!.resolve({
      status: 'completed',
      finalText: 'written',
      error: null,
      sessionId: null,
    });
    expect(await collected).toEqual({
      status: 'ok',
      result: { call_id: 'call-2', agent: 'writer', text: 'written' },
    });
  });

  it('a working caller waiting on no call is handed the question in its running turn', async () => {
    const prompts: { nodeId: string; prompt: string }[] = [];
    const { broker, items } = harness({
      launch: 'defer',
      tellLiveNode: (nodeId, prompt) => {
        prompts.push({ nodeId, prompt });
        return true;
      },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    park(broker);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.nodeId).toBe('orch');
    expect(prompts[0]!.prompt).toContain('while you work');
    expect(prompts[0]!.prompt).toContain(
      'answer_agent(call_id: "call-1", answer: ...)',
    );
    expect(
      items.some(
        (i) =>
          i.kind === 'system' &&
          String(i.payload.message).includes("Helper's question in call-1"),
      ),
    ).toBe(true);
  });

  it('a question asked BETWEEN two waits is handed to the next wait on another call — once', async () => {
    // Run 51c646fb, again: call-10's callee asked at 16:07:32 while the Manager
    // was between awaits; its next `await_agent(call-11, 300000)` began at
    // 16:10:01 and call-10 expired at 16:12:32, the question never shown.
    const { broker, deferred } = harness({ launch: 'defer' });
    for (const agent of ['helper', 'writer']) {
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent,
        message: 'm',
        mode: 'async',
      });
    }
    park(broker, { callId: 'call-1' });

    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' }),
    ).toMatchObject({
      status: 'question',
      call_id: 'call-1',
      still_running: 'call-2',
    });
    // Handed over once: the caller has seen it, so its next wait is a wait.
    const next = broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-2',
      timeout_ms: 10,
    });
    expect(await next).toMatchObject({ status: 'pending', call_id: 'call-2' });
    deferred[1]!.resolve({
      status: 'completed',
      finalText: 'written',
      error: null,
      sessionId: null,
    });
    expect(
      (await broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' })).status,
    ).toBe('ok');
  });

  it('an await that timed out stops listening: a later question from another call still reaches the working caller', async () => {
    // A caller polling with `timeout_ms` left its waiter registered; the next
    // question from ANOTHER call was handed to that dead reply and marked
    // delivered, so nothing else ever showed it.
    const told: string[] = [];
    const { broker } = harness({
      launch: 'defer',
      tellLiveNode: (_nodeId, prompt) => {
        told.push(prompt);
        return true;
      },
    });
    for (const agent of ['helper', 'writer']) {
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent,
        message: 'm',
        mode: 'async',
      });
    }
    expect(
      await broker.awaitAgent('run-1', 'orch', {
        call_id: 'call-1',
        timeout_ms: 5,
      }),
    ).toMatchObject({ status: 'pending' });

    park(broker, { callId: 'call-2' });

    expect(told).toHaveLength(1);
    expect(told[0]).toContain('call-2');
    // …and, being undelivered as an envelope, the next wait still gets it.
    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' }),
    ).toMatchObject({ status: 'question', call_id: 'call-2' });
  });

  it('a SYNC call started after another call’s question parked gets that question and stays collectable', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    park(broker, { callId: 'call-1' });
    expect(
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'writer',
        message: 'm',
      }),
    ).toMatchObject({
      status: 'question',
      call_id: 'call-1',
      still_running: 'call-2',
    });
    const collected = broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' });
    deferred[1]!.resolve({
      status: 'completed',
      finalText: 'written',
      error: null,
      sessionId: null,
    });
    expect((await collected).status).toBe('ok');
  });

  it('a SYNC call handed another call’s question restarts that question’s window', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = harness({ launch: 'defer' });
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      const { failed } = park(broker, { callId: 'call-1', ttlMs: 60 });
      await vi.advanceTimersByTimeAsync(45);
      expect(
        await broker.callAgent('run-1', 'orch', {
          title: 'why',
          agent: 'writer',
          message: 'm',
        }),
      ).toMatchObject({ status: 'question', call_id: 'call-1' });
      await vi.advanceTimersByTimeAsync(30);
      expect(failed.count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an ABANDONED sync call stops listening and stays collectable', async () => {
    const told: string[] = [];
    const { broker, deferred } = harness({
      launch: 'defer',
      tellLiveNode: (_nodeId, prompt) => {
        told.push(prompt);
        return true;
      },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const gone = new AbortController();
    const sync = broker.callAgent(
      'run-1',
      'orch',
      { title: 'why', agent: 'writer', message: 'm' },
      gone.signal,
    );
    gone.abort();
    expect(errorOf(await sync)).toContain('AWAIT_ABANDONED');

    park(broker, { callId: 'call-1' });
    expect(told).toHaveLength(1);

    // A message into a running turn is not a seen envelope, so the next wait
    // still hands the question over before it collects.
    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' }),
    ).toMatchObject({ status: 'question', call_id: 'call-1' });
    const collected = broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' });
    deferred[1]!.resolve({
      status: 'completed',
      finalText: 'written',
      error: null,
      sessionId: null,
    });
    expect((await collected).status).toBe('ok');
  });

  it('an ABANDONED await stops listening too: a later question still reaches the working caller', async () => {
    const told: string[] = [];
    const { broker } = harness({
      launch: 'defer',
      tellLiveNode: (_nodeId, prompt) => {
        told.push(prompt);
        return true;
      },
    });
    for (const agent of ['helper', 'writer']) {
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent,
        message: 'm',
        mode: 'async',
      });
    }
    const gone = new AbortController();
    const awaiting = broker.awaitAgent(
      'run-1',
      'orch',
      { call_id: 'call-1' },
      gone.signal,
    );
    gone.abort();
    expect(errorOf(await awaiting)).toContain('AWAIT_ABANDONED');

    park(broker, { callId: 'call-2' });

    expect(told).toHaveLength(1);
  });

  it('writes no "passed" row when the working caller could not take the message', async () => {
    const { broker, items } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    park(broker);
    expect(
      items.some((i) =>
        String(i.payload.message).includes("Helper's question in call-1"),
      ),
    ).toBe(false);
  });

  it('a question handed to a later wait gets its full window from that delivery', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = harness({ launch: 'defer' });
      for (const agent of ['helper', 'writer']) {
        await broker.callAgent('run-1', 'orch', {
          title: 'why',
          agent,
          message: 'm',
          mode: 'async',
        });
      }
      const { failed } = park(broker, { callId: 'call-1', ttlMs: 60 });
      await vi.advanceTimersByTimeAsync(45);
      expect(
        await broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' }),
      ).toMatchObject({ status: 'question', call_id: 'call-1' });
      // Past the park's own deadline, still answerable: the window restarted on
      // the question's OWN call, not on the call that was awaited…
      await vi.advanceTimersByTimeAsync(30);
      expect(failed.count).toBe(0);
      // …and it is a real window, which does run out.
      await vi.advanceTimersByTimeAsync(40);
      expect(failed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a question the caller only learns about LATE gets its full window from then', async () => {
    // The TTL used to run from the PARK. A caller whose collection had already
    // been abandoned was never told, so the clock timed a caller that could
    // not answer and the call failed with "the caller never answered the
    // question" — reported over a real run whose caller had asked and been cut
    // off by its own client. The window now starts at the delivery that is
    // actually observed.
    // FAKE timers, like the two tests above that pin the same re-arm. On the
    // real clock this slept 45ms against a 60ms window, and a 15ms margin is
    // not one a 228-file parallel suite can hold: under load the TTL fired
    // before the wait, and the call failed with the very error the re-arm
    // exists to prevent — passing alone and failing in `pnpm test:unit`.
    vi.useFakeTimers();
    try {
      const { broker, deferred } = harness({ launch: 'defer' });
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      const failed = park(broker, {
        ttlMs: 60,
        fail: () =>
          deferred[0]!.resolve({
            status: 'cancelled',
            finalText: null,
            error: 'run cancelled',
            sessionId: null,
          }),
      });
      // Most of the original window passes with nobody collecting.
      await vi.advanceTimersByTimeAsync(45);
      const question = await broker.awaitAgent('run-1', 'orch', {
        call_id: 'call-1',
      });
      expect(question.status).toBe('question');
      // Past the ORIGINAL deadline, and the question is still answerable —
      // without the re-arm it has already been failed by here.
      await vi.advanceTimersByTimeAsync(30);
      expect(failed.failed.count).toBe(0);
      expect(
        broker.answerAgent('run-1', 'orch', {
          call_id: 'call-1',
          answer: 'Red',
        }).status,
      ).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unanswered question times out: the callee turn is failed and the call settles as QUESTION_TIMEOUT', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    const sync = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    // The fail hook mirrors the executor: cancelling the parked turn.
    park(broker, {
      ttlMs: 10,
      fail: () =>
        deferred[0]!.resolve({
          status: 'cancelled',
          finalText: null,
          error: 'run cancelled',
          sessionId: null,
        }),
    });
    expect((await sync).status).toBe('question');
    // Let the 10ms TTL fire and the failed turn settle through the chain.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const final = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(final.status).toBe('error');
    expect(errorOf(final)).toContain('QUESTION_TIMEOUT');
    expect(items.map((i) => i.kind)).toContain('call_answer');
    expect(items.find((i) => i.kind === 'call_answer')!.payload).toMatchObject({
      outcome: 'timeout',
    });
    // Nothing left to answer once the TTL failed the call — the settled call
    // is gone from the live set entirely.
    const late = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'too late',
    });
    expect(errorOf(late)).toContain('UNKNOWN_CALL');
  });

  it('answer_agent enforces ownership and exactly-once settlement', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    // No question parked yet → NO_QUESTION, not a hang.
    const early = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'a',
    });
    expect(errorOf(early)).toContain('NO_QUESTION');
    park(broker);
    // Another node must not answer a call it does not own.
    const stolen = broker.answerAgent('run-1', 'writer', {
      call_id: 'call-1',
      answer: 'a',
    });
    expect(errorOf(stolen)).toContain('UNKNOWN_CALL');
    expect(
      broker.answerAgent('run-1', 'orch', { call_id: 'call-1', answer: 'a' })
        .status,
    ).toBe('ok');
    // Second answer finds no parked question.
    const twice = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'b',
    });
    expect(errorOf(twice)).toContain('NO_QUESTION');
    deferred[0]!.resolve({
      status: 'completed',
      finalText: '',
      error: null,
      sessionId: null,
    });
  });

  it('reports DELIVERY_FAILED when the callee turn died before the answer — and resolves the question row', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    park(broker, { deliver: () => false });
    const gone = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'a',
    });
    expect(errorOf(gone)).toContain('DELIVERY_FAILED');
    // The transcript's question row must not dangle unresolved.
    expect(items.find((i) => i.kind === 'call_answer')!.payload).toMatchObject({
      outcome: 'undelivered',
    });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: '',
      error: null,
      sessionId: null,
    });
  });

  it('orphans immediately when the question parks AFTER its owner settled — no 5-minute TTL grind', async () => {
    // A fire-and-forget (or raced) caller can settle before its callee asks;
    // drainCaller already swept and found nothing, so the park itself must
    // detect the dead owner and fail fast instead of holding the run open.
    const { broker, items, deferred } = harness({
      launch: 'defer',
      isNodeLive: () => false,
    });
    const sync = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const { failed } = park(broker, { ttlMs: 60_000 });
    expect(failed.count).toBe(1);
    expect(
      items.filter((i) => i.kind === 'call_answer').at(-1)!.payload,
    ).toMatchObject({ outcome: 'orphaned' });
    deferred[0]!.resolve({
      status: 'cancelled',
      finalText: null,
      error: 'cancelled',
      sessionId: null,
    });
    expect(errorOf(await sync)).toContain('QUESTION_ORPHANED');
  });

  it('a fire-and-forget call that asks is orphaned at once and never becomes awaitable', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    const started = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'fire_and_forget',
    });
    expect(started.status).toBe('ok');
    const { failed } = park(broker, { ttlMs: 60_000 });
    expect(failed.count).toBe(1);
    expect(
      items.filter((i) => i.kind === 'call_answer').at(-1)!.payload,
    ).toMatchObject({ outcome: 'orphaned' });
    // The "never awaitable" fire-and-forget pin survives the question path.
    const collected = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(errorOf(collected)).toContain('UNKNOWN_CALL');
    deferred[0]!.resolve({
      status: 'cancelled',
      finalText: null,
      error: null,
      sessionId: null,
    });
  });

  it('drainCaller fails a settling caller’s parked questions as QUESTION_ORPHANED', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    const sync = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const { failed } = park(broker, { ttlMs: 60_000 });
    expect((await sync).status).toBe('question');
    broker.drainCaller('run-1', 'orch');
    expect(failed.count).toBe(1);
    expect(items.find((i) => i.kind === 'call_answer')!.payload).toMatchObject({
      outcome: 'orphaned',
    });
    deferred[0]!.resolve({
      status: 'cancelled',
      finalText: null,
      error: 'run cancelled',
      sessionId: null,
    });
    const final = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(errorOf(final)).toContain('QUESTION_ORPHANED');
  });

  it('WAKES a caller whose turn ended when its callee asks — the callee keeps its question', async () => {
    // REPORTED as "workflow stopped to work in the middle without any error":
    // a Manager ended its turn, its Engineer asked something, and the park
    // orphaned the question — cancelling the Engineer — while the run closed
    // as completed. With a turn to give, the caller is woken instead.
    const wakes: { nodeId: string; prompt: string }[] = [];
    const { broker, items, deferred } = harness({
      launch: 'defer',
      isNodeLive: () => false,
      wakeNode: (nodeId, prompt) => {
        wakes.push({ nodeId, prompt });
        return true;
      },
    });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const { failed, delivered } = park(broker, { ttlMs: 60_000 });

    expect(failed.count).toBe(0);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.nodeId).toBe('orch');
    expect(wakes[0]!.prompt).toContain('"Which color?"');
    expect(wakes[0]!.prompt).toContain('answer_agent(call_id: "call-1"');
    // The transcript says why the caller is talking again.
    const notice = items.find(
      (i) => i.kind === 'system' && i.nodeId === 'orch',
    );
    expect(notice?.payload).toMatchObject({ severity: 'info' });
    // The woken caller answers exactly as a live one would have.
    const answered = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'Red',
    });
    expect(answered.status).toBe('ok');
    expect(delivered).toEqual(['Red']);
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'painted',
      error: null,
      sessionId: null,
    });
  });

  it('wakes a caller only ONCE per question — ending again unanswered orphans it, and says so', async () => {
    const wakes: string[] = [];
    const { broker, items, deferred } = harness({
      launch: 'defer',
      wakeNode: (nodeId) => {
        wakes.push(nodeId);
        return true;
      },
    });
    const sync = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const { failed } = park(broker, { ttlMs: 60_000 });
    expect((await sync).status).toBe('question');

    // The caller's turn ended with the question unanswered: woken once…
    broker.drainCaller('run-1', 'orch');
    expect(wakes).toEqual(['orch']);
    expect(failed.count).toBe(0);

    // …and its woken turn ended the same way: orphaned now, never re-woken.
    broker.drainCaller('run-1', 'orch');
    expect(wakes).toEqual(['orch']);
    expect(failed.count).toBe(1);
    expect(
      items.filter((i) => i.kind === 'call_answer').at(-1)!.payload,
    ).toMatchObject({ outcome: 'orphaned' });
    // A stop with no error anywhere is the reported defect, so it is said.
    const said = items.filter((i) => i.kind === 'system').at(-1)!.payload;
    expect(String(said.message)).toContain('Helper was stopped');
    deferred[0]!.resolve({
      status: 'cancelled',
      finalText: null,
      error: null,
      sessionId: null,
    });
  });

  it('wakes a caller whose async result landed after its turn ended — once', async () => {
    const wakes: { nodeId: string; prompt: string }[] = [];
    let live = true;
    const { broker, deferred } = harness({
      launch: 'defer',
      isNodeLive: () => live,
      wakeNode: (nodeId, prompt) => {
        wakes.push({ nodeId, prompt });
        return true;
      },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    // The caller ends with its callee still working — nothing to report yet.
    live = false;
    broker.drainCaller('run-1', 'orch');
    expect(wakes).toHaveLength(0);

    // The callee lands: THAT is when the caller is owed a turn.
    broker.noteCalleeSettling('run-1', 'call-1');
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.nodeId).toBe('orch');
    expect(wakes[0]!.prompt).toContain('await_agent(call_id: "call-1")');
    broker.noteCalleeSettling('run-1', 'call-1');
    expect(wakes).toHaveLength(1);

    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'done',
      error: null,
      sessionId: null,
    });
    const collected = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(collected.status).toBe('ok');
  });

  it('leaves a result to a LIVE caller, which collects it itself', async () => {
    const wakeNode = vi.fn(() => true);
    const { broker, deferred } = harness({ launch: 'defer', wakeNode });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    broker.noteCalleeSettling('run-1', 'call-1');
    expect(wakeNode).not.toHaveBeenCalled();
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'done',
      error: null,
      sessionId: null,
    });
  });

  it('a caller that ends with a finished result nobody collected is woken to collect it', async () => {
    const prompts: string[] = [];
    const { broker } = harness({
      wakeNode: (_nodeId, prompt) => {
        prompts.push(prompt);
        return true;
      },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    // Let the instant launch's settle chain run: the result is now WAITING.
    await new Promise((resolve) => setTimeout(resolve, 0));
    broker.drainCaller('run-1', 'orch');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Helper has finished call-1');
    broker.drainCaller('run-1', 'orch');
    expect(prompts).toHaveLength(1);
  });

  it('parkQuestion refuses unknown calls and double parking', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    expect(
      broker.parkQuestion('run-1', 'call-9', {
        question: 'q',
        options: [],
        payload: null,
        deliver: () => true,
        fail: () => {},
      }),
    ).toBe(false);
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    park(broker);
    expect(
      broker.parkQuestion('run-1', 'call-1', {
        question: 'second',
        options: [],
        payload: null,
        deliver: () => true,
        fail: () => {},
      }),
    ).toBe(false);
    deferred[0]!.resolve({
      status: 'completed',
      finalText: '',
      error: null,
      sessionId: null,
    });
  });

  it('unregisterRun defuses parked TTL timers — a dead run’s callee is never failed by a late timer', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const { failed } = park(broker, { ttlMs: 10 });
    broker.unregisterRun('run-1');
    deferred[0]!.resolve({
      status: 'cancelled',
      finalText: null,
      error: null,
      sessionId: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(failed.count).toBe(0);
  });
});

describe("CallBroker — await_agent over ALL of a caller's calls", () => {
  const done = (text: string): CalleeTurnOutcome => ({
    status: 'completed',
    finalText: text,
    error: null,
    sessionId: null,
  });
  const fanOut = async (
    broker: CallBroker,
    agents: string[],
  ): Promise<void> => {
    for (const agent of agents) {
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent,
        message: 'm',
        mode: 'async',
      });
    }
  };
  const parkOn = (broker: CallBroker, callId: string): void => {
    broker.parkQuestion('run-1', callId, {
      question: 'Which color?',
      options: ['Red', 'Blue'],
      payload: {},
      deliver: () => true,
      fail: () => {},
    });
  };

  it('returns the FIRST call to finish, naming it, and leaves the others collectable', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await fanOut(broker, ['helper', 'writer']);
    const any = broker.awaitAgent('run-1', 'orch', {});
    deferred[1]!.resolve(done('second finished first'));
    expect(await any).toEqual({
      status: 'ok',
      result: {
        call_id: 'call-2',
        agent: 'writer',
        text: 'second finished first',
      },
    });
    const next = broker.awaitAgent('run-1', 'orch', {});
    deferred[0]!.resolve(done('then the first'));
    expect(await next).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-1' },
    });
    expect(errorOf(await broker.awaitAgent('run-1', 'orch', {}))).toContain(
      'NO_OPEN_CALLS',
    );
  });

  it('returns a question from ANY call the moment it parks — and does not hand it back on the next wait', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await fanOut(broker, ['helper', 'writer']);
    const any = broker.awaitAgent('run-1', 'orch', {});
    parkOn(broker, 'call-2');
    expect(await any).toMatchObject({
      status: 'question',
      call_id: 'call-2',
      question: 'Which color?',
    });
    // Seen once: the next wait waits instead of looping on the same question.
    const next = broker.awaitAgent('run-1', 'orch', {});
    deferred[0]!.resolve(done('one'));
    expect(await next).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-1' },
    });
  });

  it('answers at once with a question that parked before the wait, or a result nobody collected', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await fanOut(broker, ['helper', 'writer']);
    parkOn(broker, 'call-1');
    expect(await broker.awaitAgent('run-1', 'orch', {})).toMatchObject({
      status: 'question',
      call_id: 'call-1',
    });
    deferred[1]!.resolve(done('already done'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await broker.awaitAgent('run-1', 'orch', {})).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-2', text: 'already done' },
    });
  });

  it('shows an already-seen question again when every open call is waiting on an answer, instead of blocking', async () => {
    // The callee waits for the answer while the caller waits for the callee:
    // without this the wait could end only in QUESTION_TIMEOUT.
    const { broker } = harness({ launch: 'defer' });
    await fanOut(broker, ['helper']);
    parkOn(broker, 'call-1');
    expect(await broker.awaitAgent('run-1', 'orch', {})).toMatchObject({
      status: 'question',
      call_id: 'call-1',
    });
    expect(await broker.awaitAgent('run-1', 'orch', {})).toMatchObject({
      status: 'question',
      call_id: 'call-1',
    });
  });

  it('keeps waiting on its other calls when a concurrent wait collects the result it raced for', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await fanOut(broker, ['helper', 'writer']);
    const any = broker.awaitAgent('run-1', 'orch', {});
    const specific = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    deferred[0]!.resolve(done('one'));
    expect(await specific).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-1' },
    });
    deferred[1]!.resolve(done('two'));
    expect(await any).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-2' },
    });
  });

  it('names the call a FAILED result came from', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await fanOut(broker, ['helper', 'writer']);
    const any = broker.awaitAgent('run-1', 'orch', {});
    deferred[0]!.resolve({
      status: 'failed',
      finalText: null,
      error: 'boom',
      sessionId: null,
    });
    expect(await any).toMatchObject({ status: 'error', call_id: 'call-1' });
  });

  it('answers pending with every call it is waiting on, and stops listening once it has', async () => {
    const told: string[] = [];
    const { broker } = harness({
      launch: 'defer',
      tellLiveNode: (_nodeId, prompt) => {
        told.push(prompt);
        return true;
      },
    });
    await fanOut(broker, ['helper', 'writer']);
    expect(await broker.awaitAgent('run-1', 'orch', { timeout_ms: 5 })).toEqual(
      {
        status: 'pending',
        call_id: 'call-1',
        agent: 'helper',
        waiting_on: [
          { call_id: 'call-1', agent: 'helper' },
          { call_id: 'call-2', agent: 'writer' },
        ],
      },
    );
    parkOn(broker, 'call-2');
    expect(told).toHaveLength(1);
  });
});

describe('CallBroker — thread continuation', () => {
  it('continuing a thread resumes the recorded callee session', async () => {
    const { broker, launches, items } = harness();
    const first = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'remember the codeword BANANA',
    });
    expect(first.status).toBe('ok');

    const second = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'what was the codeword?',
      thread: 'call-1',
    });
    expect(second).toEqual({
      status: 'ok',
      result: { call_id: 'call-2', agent: 'helper', text: 'done by helper' },
    });
    // The continuation turn resumed call-1's recorded CLI session…
    expect(launches[1]!.resumeSessionId).toBe('sess-call-1');
    // …while the first turn started fresh.
    expect(launches[0]!.resumeSessionId).toBeNull();
    // The transcript's call_started row names the continued thread.
    const started = items.filter((i) => i.kind === 'call_started');
    expect(started[1]!.payload).toMatchObject({
      callId: 'call-2',
      thread: 'call-1',
    });
    expect(started[0]!.payload).not.toHaveProperty('thread');
  });

  it('a continued thread can itself be continued (chained resumes)', async () => {
    const { broker, launches } = harness();
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'a',
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'b',
      thread: 'call-1',
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'c',
      thread: 'call-2',
    });
    expect(launches.map((l) => l.resumeSessionId)).toEqual([
      null,
      'sess-call-1',
      'sess-call-2',
    ]);
  });

  it('refuses an unknown thread and a thread another caller started', async () => {
    const calleesOf = new Map([
      ['orch', [HELPER]],
      ['other', [HELPER]],
    ]);
    const { broker, launches } = harness({ calleesOf });
    const unknown = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      thread: 'call-99',
    });
    expect(unknown.status).toBe('error');
    expect(errorOf(unknown)).toContain('UNKNOWN_THREAD');
    expect(launches).toHaveLength(0);

    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const foreign = await broker.callAgent('run-1', 'other', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      thread: 'call-1',
    });
    expect(foreign.status).toBe('error');
    expect(errorOf(foreign)).toContain('UNKNOWN_THREAD');
  });

  it('refuses continuing a thread with a different agent', async () => {
    const { broker } = harness();
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const mismatch = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'writer',
      message: 'm',
      thread: 'call-1',
    });
    expect(mismatch.status).toBe('error');
    expect(errorOf(mismatch)).toContain('THREAD_AGENT_MISMATCH');
  });

  it('refuses a thread whose turn recorded no resumable session', async () => {
    const { broker } = harness({ noSession: true });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      thread: 'call-1',
    });
    expect(envelope.status).toBe('error');
    expect(errorOf(envelope)).toContain('THREAD_UNAVAILABLE');
  });
});

/**
 * F22: `untilAbandoned` and `untilDeadline` (the two private wrappers
 * `awaitAgent` composes around `waitForOutcome`) used to forward only the
 * fulfillment arm of the promise they wrap (`promise.then(onFulfilled)`,
 * no rejection handler). A rejecting inner promise therefore left the
 * wrapper's own returned promise pending FOREVER instead of propagating the
 * failure — `awaitAgent` would hang rather than let the rejection reach the
 * MCP dispatcher's ordinary error mapping.
 *
 * These specs call the two wrappers directly (via a narrow structural cast —
 * neither method reads `this`) rather than staging a call/callee scenario
 * that reaches a rejection: in production `call.settled` always carries a
 * `.catch` (see `callAgent`), so this is a defensive contract the wrappers
 * must honor even though nothing on the ordinary call path exercises it
 * today.
 */
interface UntilWrappers {
  untilAbandoned<T>(
    signal: AbortSignal | undefined,
    promise: Promise<T>,
  ): Promise<T | symbol>;
  untilDeadline<T>(
    timeoutMs: number | undefined,
    promise: Promise<T>,
  ): Promise<T | symbol>;
}

function untilWrappersOf(broker: CallBroker): UntilWrappers {
  return broker as unknown as UntilWrappers;
}

describe('CallBroker — untilAbandoned / untilDeadline reject propagation', () => {
  it('untilAbandoned rejects instead of hanging when the wrapped promise rejects', async () => {
    const { untilAbandoned } = untilWrappersOf(new CallBroker());
    // Never aborts — this exercises the reject arm of the settle race, not
    // the abort arm.
    const controller = new AbortController();
    const failure = new Error('callee turn blew up');
    await expect(
      untilAbandoned(controller.signal, Promise.reject(failure)),
    ).rejects.toBe(failure);
  }, 2000);

  it('untilAbandoned still resolves normally when the wrapped promise resolves', async () => {
    const { untilAbandoned } = untilWrappersOf(new CallBroker());
    const controller = new AbortController();
    const outcome = { status: 'ok' as const };
    await expect(
      untilAbandoned(controller.signal, Promise.resolve(outcome)),
    ).resolves.toBe(outcome);
  });

  it('untilDeadline rejects instead of hanging when the wrapped promise rejects', async () => {
    const { untilDeadline } = untilWrappersOf(new CallBroker());
    const failure = new Error('callee turn blew up');
    // A deadline far outside this test's own timeout: on the unfixed wrapper
    // the promise never settles within that window (no reject arm, and the
    // timer would not fire first either), so the assertion below fails by
    // timing out rather than by resolving to the wrong thing — still a red
    // test either way.
    await expect(untilDeadline(60_000, Promise.reject(failure))).rejects.toBe(
      failure,
    );
  }, 2000);

  it('untilDeadline still resolves normally when the wrapped promise resolves', async () => {
    const { untilDeadline } = untilWrappersOf(new CallBroker());
    const outcome = { status: 'ok' as const };
    await expect(untilDeadline(60_000, Promise.resolve(outcome))).resolves.toBe(
      outcome,
    );
  });
});

describe('CallBroker — a call whose callee goes quiet', () => {
  // The gap this milestone's own verification named: every abandonment and
  // deadline case in this file enters through `awaitAgent`, and none drives
  // the SYNC arm — which is the arm a live cursor call was measured taking
  // (`call_started` carrying `mode: 'sync'`), and the one whose wait has
  // neither a deadline nor an abandon race around it.

  it('says so in the caller transcript, and does NOT settle the call', async () => {
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      let settled = false;
      const call = broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'take your time',
      });
      void call.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);

      const stalls = items.filter((i) => i.payload.stalledCall === true);
      expect(stalls).toHaveLength(1);
      expect(stalls[0]!.kind).toBe('system');
      // On the CALLER's node — it is the caller's transcript that had no way
      // to say anything about a callee that had stopped.
      expect(stalls[0]!.nodeId).toBe('orch');
      expect(stalls[0]!.payload).toMatchObject({
        callId: 'call-1',
        calleeNodeId: 'helper',
      });
      // The KEY, not just the presence of a sentence: `transcript-item.tsx`
      // reads a `system` row's `message` and draws nothing without it, so a
      // row whose wording sits under any other key is persisted, folded, and
      // invisible. `severity` matters for the same reason — an absent one
      // resolves to the red failure chrome, and nothing here has failed.
      expect(stalls[0]!.payload.message).toContain('has produced nothing');
      expect(stalls[0]!.payload.severity).toBe('info');

      // The whole of the carve-out: SURFACED, never cancelled — a sync call
      // has no deadline of its own.
      expect(settled).toBe(false);
      expect(items.some((i) => i.kind === 'call_result')).toBe(false);

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'late, but fine',
        error: null,
        sessionId: 'sess-1',
      });
      await call;
      // And it settles normally afterwards — the advisory changed nothing
      // about the call's own outcome.
      expect(items.some((i) => i.kind === 'call_result')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stands down while the callee is blocked on a verdict, and resumes after', async () => {
    // A callee parked on an approval card emits nothing by construction, so a
    // window left running would be timing the PERSON reading the card and
    // would report a callee doing exactly what it should. `spawn-cli.ts`
    // suspends its own silence deadline on the same reasoning.
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      const call = broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'ask me something',
      });

      broker.noteCalleeBlocked('run-1', 'call-1');
      // An hour on a card is a long think, not a stall.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(items.some((i) => i.payload.stalledCall === true)).toBe(false);

      // Answered — and now the silence counts again, from here.
      broker.noteCalleeUnblocked('run-1', 'call-1');
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(items.filter((i) => i.payload.stalledCall === true)).toHaveLength(
        1,
      );

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'done',
        error: null,
        sessionId: 'sess-1',
      });
      await call;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stands down while the callee waits on its own tool call, and resumes after it answers', async () => {
    // REPORTED as "'qa' has produced nothing for 10 minutes" over a QA agent
    // that had launched ten reviewer sub-agents as `Task` tool calls: their
    // results arrived eleven minutes apart and nothing reached the wire in
    // between. A callee waiting on its own tool is working.
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      const call = broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'review it',
      });

      // The tool call is itself a persisted row, so the executor reports both.
      broker.noteCalleeToolStarted('run-1', 'call-1', 'tool-a');
      broker.noteCalleeActivity('run-1', 'call-1');
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(items.some((i) => i.payload.stalledCall === true)).toBe(false);

      // Answered — and now the silence counts again, from here.
      broker.noteCalleeToolFinished('run-1', 'call-1', 'tool-a');
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(items.filter((i) => i.payload.stalledCall === true)).toHaveLength(
        1,
      );

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'done',
        error: null,
        sessionId: 'sess-1',
      });
      await call;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays suspended even though the card itself is a row', async () => {
    // The trap in the pairing: an `approval_request` is PERSISTED, so the
    // executor's own activity hook fires for the very event that suspended the
    // window. Without the guard in `armSilenceWatch` that row would re-arm it
    // and the carve-out above would do nothing.
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      const call = broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'ask me something',
      });

      broker.noteCalleeBlocked('run-1', 'call-1');
      broker.noteCalleeActivity('run-1', 'call-1');
      await vi.advanceTimersByTimeAsync(30 * 60_000);

      expect(items.some((i) => i.payload.stalledCall === true)).toBe(false);

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'done',
        error: null,
        sessionId: 'sess-1',
      });
      await call;
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes NOTHING once the run is unregistered', async () => {
    // The teardown case, and the one the sibling `parked` timer's own comment
    // already warned about: a wedged callee is both what arms this watchdog
    // AND what makes `RunTeardownService`'s settle wait give up and purge the
    // run anyway. A timer left armed then inserts an `items` row for a run
    // whose rows are gone — and `Item.runId` has no foreign key, so the insert
    // SUCCEEDS and leaves transcript text no route can reach or delete.
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      void broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'wedge',
      });

      broker.unregisterRun('run-1');
      await vi.advanceTimersByTimeAsync(30 * 60_000);

      expect(items.some((i) => i.payload.stalledCall === true)).toBe(false);

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'never collected',
        error: null,
        sessionId: 'sess-1',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms on every callee row, so a WORKING callee is never called stalled', async () => {
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      const call = broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'work steadily',
      });

      // Twenty-seven minutes of work, never nine of them silent. A total-
      // duration cap would have fired twice over by here — which is the
      // behaviour the silence bound exists instead of.
      for (let i = 0; i < 3; i += 1) {
        await vi.advanceTimersByTimeAsync(9 * 60_000);
        broker.noteCalleeActivity('run-1', 'call-1');
      }

      expect(items.some((i) => i.payload.stalledCall === true)).toBe(false);

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'done',
        error: null,
        sessionId: 'sess-1',
      });
      await call;
    } finally {
      vi.useRealTimers();
    }
  });

  it('says it ONCE, even after the callee wakes and goes quiet again', async () => {
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      const call = broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'hang',
      });

      // Go quiet, be reported, produce ONE row, then go quiet again. The
      // second silence re-arms the watchdog and fires it a second time — so
      // this drives the `saidStalled` guard rather than the one-shot timer,
      // which would have passed with the guard deleted.
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      broker.noteCalleeActivity('run-1', 'call-1');
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);

      // An advisory per silent stretch would bury the conversation it is
      // warning about.
      expect(items.filter((i) => i.payload.stalledCall === true)).toHaveLength(
        1,
      );

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'eventually',
        error: null,
        sessionId: 'sess-1',
      });
      await call;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CallBroker — one process per conversation', () => {
  it('a continuation runs in the conversation of the call it continues, however deep the chain', async () => {
    const { broker, launches } = harness();
    await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'a',
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'b',
      thread: 'call-1',
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'c',
      thread: 'call-2',
    });
    // A fresh call beside them opens a conversation of its own.
    await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'd',
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'e',
      thread: 'call-4',
    });
    expect(launches.map((l) => [l.callId, l.conversationId])).toEqual([
      ['call-1', 'call-1'],
      ['call-2', 'call-1'],
      ['call-3', 'call-1'],
      ['call-4', 'call-4'],
      ['call-5', 'call-4'],
    ]);
  });

  it('refuses to continue a conversation a call is still running on, and accepts once it has settled', async () => {
    // Two live calls on one conversation is the fork this keying exists to
    // end — or, keyed together, the registry replacing a running process.
    const { broker, launches, deferred } = harness({ launch: 'defer' });
    const first = broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'a',
    });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'a done',
      error: null,
      sessionId: 'sess-1',
    });
    expect((await first).status).toBe('ok');
    const running = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'b',
      thread: 'call-1',
      mode: 'async',
    });
    expect(running.status).toBe('ok');

    const busy = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'c',
      thread: 'call-1',
    });
    expect(busy.status).toBe('error');
    expect(errorOf(busy)).toContain('THREAD_BUSY');
    // Names the call to await, so the caller knows what to do next.
    expect(errorOf(busy)).toContain("'call-2'");
    expect(launches).toHaveLength(2);

    // Another conversation is untouched by it.
    const other = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'writer',
      message: 'x',
      mode: 'async',
    });
    expect(other.status).toBe('ok');

    deferred[1]!.resolve({
      status: 'completed',
      finalText: 'b done',
      error: null,
      sessionId: 'sess-1',
    });
    expect(
      (await broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' })).status,
    ).toBe('ok');
    const again = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'c',
      thread: 'call-2',
      mode: 'async',
    });
    expect(again).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-4' },
    });
    expect(launches[3]).toMatchObject({
      callId: 'call-4',
      resumeSessionId: 'sess-1',
      conversationId: 'call-1',
    });
  });
});

describe('CallBroker — a caller blocked on a card of its own', () => {
  function parkOn(
    broker: CallBroker,
    callId: string,
    ttlMs: number,
    failed: { count: number },
  ): void {
    expect(
      broker.parkQuestion('run-1', callId, {
        question: 'Which?',
        options: ['A', 'B'],
        payload: null,
        ttlMs,
        deliver: () => true,
        fail: () => {
          failed.count += 1;
        },
      }),
    ).toBe(true);
  }

  it('a question parked while its caller is blocked does not expire; its window starts when the caller is unblocked', async () => {
    // Both QUESTION_TIMEOUTs on a real run fired inside the caller's own
    // question to the user — the one moment it could not answer_agent.
    vi.useFakeTimers();
    try {
      const { broker } = harness({ launch: 'defer' });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      broker.noteCallerBlocked('run-1', 'orch', 'card-1');
      const failed = { count: 0 };
      parkOn(broker, 'call-1', 1_000, failed);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(failed.count).toBe(0);

      broker.noteCallerUnblocked('run-1', 'orch', 'card-1');
      await vi.advanceTimersByTimeAsync(999);
      expect(failed.count).toBe(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(failed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a card raised after the question parked suspends its running window, and the unblock gives it a full one', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = harness({ launch: 'defer' });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      const failed = { count: 0 };
      parkOn(broker, 'call-1', 1_000, failed);
      await vi.advanceTimersByTimeAsync(600);
      broker.noteCallerBlocked('run-1', 'orch', 'card-1');
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(failed.count).toBe(0);

      broker.noteCallerUnblocked('run-1', 'orch', 'card-1');
      // A FULL window from the unblock, not the 400ms that were left.
      await vi.advanceTimersByTimeAsync(999);
      expect(failed.count).toBe(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(failed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with two cards up, the window resumes only when the last is answered', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = harness({ launch: 'defer' });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      broker.noteCallerBlocked('run-1', 'orch', 'card-a');
      broker.noteCallerBlocked('run-1', 'orch', 'card-b');
      const failed = { count: 0 };
      parkOn(broker, 'call-1', 1_000, failed);
      broker.noteCallerUnblocked('run-1', 'orch', 'card-a');
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(failed.count).toBe(0);
      broker.noteCallerUnblocked('run-1', 'orch', 'card-b');
      await vi.advanceTimersByTimeAsync(1_001);
      expect(failed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the SAME card offered twice is one blocker — its one answer resumes the questions', async () => {
    // REVIEWED: spawn-cli re-offers a request its turn settled without an
    // answer to the next turn of the same process, so one card can reach the
    // seam twice. Counted, it then needed two answers to that one card.
    vi.useFakeTimers();
    try {
      const { broker } = harness({ launch: 'defer' });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      broker.noteCallerBlocked('run-1', 'orch', 'card-1');
      broker.noteCallerBlocked('run-1', 'orch', 'card-1');
      const failed = { count: 0 };
      parkOn(broker, 'call-1', 1_000, failed);
      broker.noteCallerUnblocked('run-1', 'orch', 'card-1');
      await vi.advanceTimersByTimeAsync(1_001);
      expect(failed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a callee waiting on its own caller cannot answer its callees either: their questions wait with it', async () => {
    // REVIEWED: Manager → Engineer → Researcher. An Engineer parked on a
    // question to its Manager cannot answer_agent its Researcher, so the
    // Researcher's clock must not run until the Manager has answered.
    vi.useFakeTimers();
    try {
      const { broker } = harness({
        launch: 'defer',
        calleesOf: new Map([
          ['orch', [HELPER]],
          ['helper', [WRITER]],
        ]),
      });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      await broker.callAgent('run-1', 'helper', {
        title: 'work',
        agent: 'writer',
        message: 'm',
        mode: 'async',
      });
      const helperFailed = { count: 0 };
      parkOn(broker, 'call-1', 24 * 60 * 60_000, helperFailed);
      const writerFailed = { count: 0 };
      parkOn(broker, 'call-2', 1_000, writerFailed);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(writerFailed.count).toBe(0);

      expect(
        broker.answerAgent('run-1', 'orch', { call_id: 'call-1', answer: 'A' })
          .status,
      ).toBe('ok');
      await vi.advanceTimersByTimeAsync(999);
      expect(writerFailed.count).toBe(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(writerFailed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("every way out of the callee's own park releases its callees' questions — a timeout, and its turn settling", async () => {
    // `unpark` is the one exit from a park precisely so no ending can leave a
    // callee blocked with nothing left to release it; pin the two that are not
    // an answer.
    for (const ending of ['timeout', 'settle'] as const) {
      vi.useFakeTimers();
      try {
        const { broker, deferred } = harness({
          launch: 'defer',
          calleesOf: new Map([
            ['orch', [HELPER]],
            ['helper', [WRITER]],
          ]),
        });
        await broker.callAgent('run-1', 'orch', {
          title: 'work',
          agent: 'helper',
          message: 'm',
          mode: 'async',
        });
        await broker.callAgent('run-1', 'helper', {
          title: 'work',
          agent: 'writer',
          message: 'm',
          mode: 'async',
        });
        const helperFailed = { count: 0 };
        parkOn(
          broker,
          'call-1',
          ending === 'timeout' ? 10_000 : 24 * 60 * 60_000,
          helperFailed,
        );
        const writerFailed = { count: 0 };
        parkOn(broker, 'call-2', 5_000, writerFailed);

        // Twice the writer's own window: held while its caller is parked.
        await vi.advanceTimersByTimeAsync(10_001);
        expect(writerFailed.count, ending).toBe(0);
        if (ending === 'timeout') {
          expect(helperFailed.count).toBe(1);
        } else {
          expect(helperFailed.count).toBe(0);
          deferred[0]!.resolve({
            status: 'cancelled',
            finalText: null,
            error: 'run cancelled',
            sessionId: null,
          });
          await vi.advanceTimersByTimeAsync(1);
        }
        // A full window from the release, not from the park.
        await vi.advanceTimersByTimeAsync(4_997);
        expect(writerFailed.count, ending).toBe(0);
        await vi.advanceTimersByTimeAsync(3);
        expect(writerFailed.count, ending).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('a caller that ended its turn with a card open is blocked no more: the question it is woken with runs on its own clock', async () => {
    // Its cards are swept with its turn, so a count left behind here would
    // suspend every question it is woken with for good.
    vi.useFakeTimers();
    try {
      const { broker } = harness({ launch: 'defer', wakeNode: () => true });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      broker.noteCallerBlocked('run-1', 'orch', 'card-1');
      const failed = { count: 0 };
      parkOn(broker, 'call-1', 1_000, failed);
      broker.drainCaller('run-1', 'orch');
      await vi.advanceTimersByTimeAsync(1_001);
      expect(failed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the silence watchdog stands down while the callee is parked and restarts when the answer lands', async () => {
    // With the TTL suspended a question can outlive the ten-minute silence
    // window, and "has produced nothing" about a callee waiting on its caller
    // would be true and useless — the same carve-out an approval card gets.
    vi.useFakeTimers();
    try {
      const { broker, items } = harness({ launch: 'defer' });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      const failed = { count: 0 };
      parkOn(broker, 'call-1', 60 * 60_000, failed);
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(items.filter((i) => i.payload.stalledCall === true)).toHaveLength(
        0,
      );
      expect(
        broker.answerAgent('run-1', 'orch', { call_id: 'call-1', answer: 'A' })
          .status,
      ).toBe('ok');
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(items.filter((i) => i.payload.stalledCall === true)).toHaveLength(
        1,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CallBroker — seeded from an earlier daemon', () => {
  const SEED: RunCallSeed = {
    callSeq: 3,
    records: [
      {
        callId: 'call-1',
        callerNodeId: 'orch',
        calleeNodeId: 'helper',
        thread: null,
        sessionId: 'sess-old',
      },
      {
        callId: 'call-2',
        callerNodeId: 'orch',
        calleeNodeId: 'writer',
        thread: null,
        sessionId: null,
      },
      {
        callId: 'call-3',
        callerNodeId: 'orch',
        calleeNodeId: 'helper',
        thread: 'call-1',
        sessionId: 'sess-old',
      },
    ],
  };

  it('call ids continue past the transcript instead of colliding with it', async () => {
    const { broker } = harness({ seed: SEED });
    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'm',
    });
    expect(envelope).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-4' },
    });
  });

  it('a conversation from before the restart is continued, in the conversation it belonged to', async () => {
    const { broker, launches } = harness({ seed: SEED });
    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'go on',
      thread: 'call-3',
    });
    expect(envelope.status).toBe('ok');
    // call-3 continued call-1, so its conversation is call-1's — rebuilt
    // through the parent chain rather than named after itself.
    expect(launches[0]).toMatchObject({
      callId: 'call-4',
      resumeSessionId: 'sess-old',
      conversationId: 'call-1',
    });
  });

  it('a seeded call that recorded no session cannot be continued, and says so', async () => {
    const { broker } = harness({ seed: SEED });
    const refused = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'writer',
      message: 'm',
      thread: 'call-2',
    });
    expect(errorOf(refused)).toContain('THREAD_UNAVAILABLE');
  });

  it('collecting or answering a call from before the restart says its result is gone, naming the thread that survives', async () => {
    const { broker } = harness({ seed: SEED });
    const awaited = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(errorOf(awaited)).toContain('UNKNOWN_CALL');
    expect(errorOf(awaited)).toContain('before the daemon restarted');
    expect(errorOf(awaited)).toContain("thread: 'call-1'");
    // One that recorded no session offers no thread to continue.
    const noThread = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-2',
    });
    expect(errorOf(noThread)).toContain('before the daemon restarted');
    expect(errorOf(noThread)).not.toContain('thread:');
    const answered = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-3',
      answer: 'x',
    });
    expect(errorOf(answered)).toContain('before the daemon restarted');
    // An id nobody ever minted keeps the plain refusal.
    const never = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-9',
    });
    expect(errorOf(never)).toBe(
      "UNKNOWN_CALL: no un-collected async call 'call-9' started by you",
    );
  });
});
