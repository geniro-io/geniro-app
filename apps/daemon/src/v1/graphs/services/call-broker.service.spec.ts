import { describe, expect, it } from 'vitest';

import type { ItemKind } from '../../runs/runs.types';
import type {
  CalleeTurnOutcome,
  RunCallCapability,
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
}): {
  broker: CallBroker;
  capability: RunCallCapability;
  items: RecordedItem[];
  launches: { callee: WorkflowAgentNode; message: string; callId: string }[];
  deferred: Deferred[];
} {
  const items: RecordedItem[] = [];
  const launches: {
    callee: WorkflowAgentNode;
    message: string;
    callId: string;
  }[] = [];
  const deferred: Deferred[] = [];
  const mode = options?.launch ?? 'instant';
  const capability: RunCallCapability = {
    calleesOf: options?.calleesOf ?? new Map([['orch', [HELPER, WRITER]]]),
    launchCalleeTurn: (callee, message, callId) => {
      launches.push({ callee, message, callId });
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
  };
  const broker = new CallBroker();
  broker.registerRun('run-1', capability);
  return { broker, capability, items, launches, deferred };
}

describe('CallBroker', () => {
  it('sync call: launches the callee and returns its text in an ok envelope', async () => {
    const { broker, items, launches } = harness();
    const envelope = await broker.callAgent('run-1', 'orch', {
      agent: 'helper',
      message: 'summarize X',
    });
    expect(envelope).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'done by helper' },
    });
    expect(launches).toEqual([
      { callee: HELPER, message: 'summarize X', callId: 'call-1' },
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
    });
  });

  it('resolves the callee by display name and refuses names off the call wiring', async () => {
    const { broker } = harness();
    const byName = await broker.callAgent('run-1', 'orch', {
      agent: 'Helper',
      message: 'm',
    });
    expect(byName.status).toBe('ok');
    const unknown = await broker.callAgent('run-1', 'orch', {
      agent: 'stranger',
      message: 'm',
    });
    expect(unknown.status).toBe('error');
    expect(unknown.error).toContain('UNKNOWN_AGENT');
    expect(unknown.error).toContain('Helper'); // the wired list is named back
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
      agent: 'Twin',
      message: 'm',
    });
    expect(envelope.status).toBe('error');
    expect(envelope.error).toContain('UNKNOWN_AGENT');
    // The exact id still works.
    const byId = await broker.callAgent('run-1', 'orch', {
      agent: 'writer-2',
      message: 'm',
    });
    expect(byId.status).toBe('ok');
  });

  it('a caller with no call edges gets UNKNOWN_AGENT (callable: none)', async () => {
    const { broker } = harness();
    const envelope = await broker.callAgent('run-1', 'lonely', {
      agent: 'helper',
      message: 'm',
    });
    expect(envelope.status).toBe('error');
    expect(envelope.error).toContain('callable: none');
  });

  it('async call returns a call_id at once; await_agent collects exactly once', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    const started = await broker.callAgent('run-1', 'orch', {
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
    expect(again.error).toContain('UNKNOWN_CALL');
  });

  it('two concurrent await_agent waiters on one async call still collect exactly once', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
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
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const stolen = await broker.awaitAgent('run-1', 'writer', {
      call_id: 'call-1',
    });
    expect(stolen.error).toContain('UNKNOWN_CALL');
    deferred[0]!.resolve({ status: 'completed', finalText: '', error: null });
  });

  it('fire_and_forget detaches: transcript only, never awaitable', async () => {
    const { broker, items } = harness();
    const detached = await broker.callAgent('run-1', 'orch', {
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
    expect(collected.error).toContain('UNKNOWN_CALL');
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
    const p1 = broker.callAgent('run-1', 'a', { agent: 'b', message: 'm' });
    const p2 = broker.callAgent('run-1', 'b', { agent: 'c', message: 'm' });
    const p3 = broker.callAgent('run-1', 'c', { agent: 'd', message: 'm' });
    const refused = await broker.callAgent('run-1', 'd', {
      agent: 'e',
      message: 'm',
    });
    expect(refused.status).toBe('error');
    expect(refused.error).toContain('DEPTH_LIMIT');
    for (const d of deferred) {
      d.resolve({ status: 'completed', finalText: '', error: null });
    }
    await Promise.all([p1, p2, p3]);
  });

  it('caps total callee turns per run', async () => {
    const { broker } = harness();
    for (let i = 0; i < 50; i++) {
      const envelope = await broker.callAgent('run-1', 'orch', {
        agent: 'helper',
        message: `call ${i}`,
        mode: 'fire_and_forget',
      });
      expect(envelope.status).toBe('ok');
    }
    const over = await broker.callAgent('run-1', 'orch', {
      agent: 'helper',
      message: 'one too many',
    });
    expect(over.status).toBe('error');
    expect(over.error).toContain('TURN_LIMIT');
  });

  it('maps callee failure and cancellation into error envelopes', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const failing = broker.callAgent('run-1', 'orch', {
      agent: 'helper',
      message: 'm',
    });
    deferred[0]!.resolve({
      status: 'failed',
      finalText: null,
      error: 'exit 1',
    });
    expect((await failing).error).toContain('CALLEE_FAILED: exit 1');

    const cancelled = broker.callAgent('run-1', 'orch', {
      agent: 'helper',
      message: 'm',
    });
    deferred[1]!.resolve({
      status: 'cancelled',
      finalText: null,
      error: 'run cancelled',
    });
    expect((await cancelled).error).toContain('CALLEE_CANCELLED');
  });

  it('wraps a throwing launch in CALL_FAILED instead of rejecting', async () => {
    const { broker } = harness({ launch: 'throw' });
    const envelope = await broker.callAgent('run-1', 'orch', {
      agent: 'helper',
      message: 'm',
    });
    expect(envelope.status).toBe('error');
    expect(envelope.error).toContain('CALL_FAILED: spawn exploded');
  });

  it('refuses calls for unregistered runs and cancelled runs', async () => {
    const { broker } = harness({ cancelled: true });
    const cancelled = await broker.callAgent('run-1', 'orch', {
      agent: 'helper',
      message: 'm',
    });
    expect(cancelled.error).toContain('RUN_CANCELLED');

    broker.unregisterRun('run-1');
    expect(broker.hasRun('run-1')).toBe(false);
    const gone = await broker.callAgent('run-1', 'orch', {
      agent: 'helper',
      message: 'm',
    });
    expect(gone.error).toContain('RUN_NOT_ACTIVE');
    const goneAwait = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(goneAwait.error).toContain('RUN_NOT_ACTIVE');
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
    deferred[0]!.resolve({ status: 'completed', finalText: 'ok', error: null });
    expect((await second).status).toBe('ok');
  });

  it('an unanswered question times out: the callee turn is failed and the call settles as QUESTION_TIMEOUT', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    const sync = broker.callAgent('run-1', 'orch', {
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
        }),
    });
    expect((await sync).status).toBe('question');
    // Let the 10ms TTL fire and the failed turn settle through the chain.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const final = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(final.status).toBe('error');
    expect(final.error).toContain('QUESTION_TIMEOUT');
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
    expect(late.error).toContain('UNKNOWN_CALL');
  });

  it('answer_agent enforces ownership and exactly-once settlement', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    void broker.callAgent('run-1', 'orch', { agent: 'helper', message: 'm' });
    // No question parked yet → NO_QUESTION, not a hang.
    const early = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'a',
    });
    expect(early.error).toContain('NO_QUESTION');
    park(broker);
    // Another node must not answer a call it does not own.
    const stolen = broker.answerAgent('run-1', 'writer', {
      call_id: 'call-1',
      answer: 'a',
    });
    expect(stolen.error).toContain('UNKNOWN_CALL');
    expect(
      broker.answerAgent('run-1', 'orch', { call_id: 'call-1', answer: 'a' })
        .status,
    ).toBe('ok');
    // Second answer finds no parked question.
    const twice = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'b',
    });
    expect(twice.error).toContain('NO_QUESTION');
    deferred[0]!.resolve({ status: 'completed', finalText: '', error: null });
  });

  it('reports DELIVERY_FAILED when the callee turn died before the answer — and resolves the question row', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    void broker.callAgent('run-1', 'orch', { agent: 'helper', message: 'm' });
    park(broker, { deliver: () => false });
    const gone = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'a',
    });
    expect(gone.error).toContain('DELIVERY_FAILED');
    // The transcript's question row must not dangle unresolved.
    expect(items.find((i) => i.kind === 'call_answer')!.payload).toMatchObject({
      outcome: 'undelivered',
    });
    deferred[0]!.resolve({ status: 'completed', finalText: '', error: null });
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
    });
    expect((await sync).error).toContain('QUESTION_ORPHANED');
  });

  it('a fire-and-forget call that asks is orphaned at once and never becomes awaitable', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    const started = await broker.callAgent('run-1', 'orch', {
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
    expect(collected.error).toContain('UNKNOWN_CALL');
    deferred[0]!.resolve({ status: 'cancelled', finalText: null, error: null });
  });

  it('drainCaller fails a settling caller’s parked questions as QUESTION_ORPHANED', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    const sync = broker.callAgent('run-1', 'orch', {
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
    });
    const final = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(final.error).toContain('QUESTION_ORPHANED');
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
    void broker.callAgent('run-1', 'orch', { agent: 'helper', message: 'm' });
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
    deferred[0]!.resolve({ status: 'completed', finalText: '', error: null });
  });

  it('unregisterRun defuses parked TTL timers — a dead run’s callee is never failed by a late timer', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    void broker.callAgent('run-1', 'orch', { agent: 'helper', message: 'm' });
    const { failed } = park(broker, { ttlMs: 10 });
    broker.unregisterRun('run-1');
    deferred[0]!.resolve({ status: 'cancelled', finalText: null, error: null });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(failed.count).toBe(0);
  });
});
