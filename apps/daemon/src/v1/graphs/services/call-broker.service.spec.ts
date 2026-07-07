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
