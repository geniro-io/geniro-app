import { describe, expect, it } from 'vitest';

import type { ItemKind } from '../../runs/runs.types';
import { type ItemWire, RUN_CALL_BRIEF_MAX } from '../chat.types';
import { foldRunCalls, foldRunDelegates } from './run-state-folds';

function row(
  seq: number,
  kind: ItemKind,
  payload: unknown,
  nodeId: string | null = 'manager',
): ItemWire {
  return {
    id: `i${seq}`,
    runId: 'run',
    nodeId,
    seq,
    kind,
    role: null,
    payload,
    createdAt: new Date(seq * 1000).toISOString(),
  };
}

describe('foldRunCalls', () => {
  it('reads a call with no settle as still out, and one that settled as its envelope says', () => {
    const calls = foldRunCalls([
      row(1, 'call_started', { callId: 'call-1', calleeNodeId: 'qa' }),
      row(2, 'call_started', { callId: 'call-2', calleeNodeId: 'qa' }),
      row(3, 'call_started', { callId: 'call-3', calleeNodeId: 'qa' }),
      row(4, 'call_result', { callId: 'call-1', status: 'ok' }),
      row(5, 'call_result', {
        callId: 'call-2',
        status: 'error',
        error: 'CALLEE_CANCELLED: stopped by manager',
      }),
    ]);

    expect(calls.map((call) => [call.callId, call.status])).toEqual([
      ['call-1', 'completed'],
      ['call-2', 'cancelled'],
      ['call-3', 'running'],
    ]);
    expect(calls[0]!.endedAt).toBe(new Date(4000).toISOString());
    expect(calls[2]!.endedAt).toBeNull();
  });

  it('takes the caller from the payload over the row, and caps the brief', () => {
    const [call] = foldRunCalls([
      row(1, 'call_started', {
        callId: 'call-1',
        callerNodeId: 'lead',
        message: 'x'.repeat(RUN_CALL_BRIEF_MAX + 50),
        thread: 'call-0',
      }),
    ]);
    expect(call!.callerNodeId).toBe('lead');
    expect(call!.brief).toHaveLength(RUN_CALL_BRIEF_MAX);
    expect(call!.thread).toBe('call-0');
  });

  it('reads an error envelope that is not a cancel as failed', () => {
    const [call] = foldRunCalls([
      row(1, 'call_started', { callId: 'call-1' }),
      row(2, 'call_result', {
        callId: 'call-1',
        status: 'error',
        error: 'CALLEE_FAILED[crashed]: exited',
      }),
    ]);
    expect(call!.status).toBe('failed');
  });

  it('names the pool member: the settle’s, else the newest hand-off’s, else the start’s', () => {
    const calls = foldRunCalls(
      [
        row(1, 'call_started', { callId: 'call-1', member: 1 }),
        row(2, 'call_started', { callId: 'call-2', member: 1 }),
        row(3, 'call_started', { callId: 'call-3', member: 1 }),
        row(4, 'call_started', { callId: 'call-4' }),
        row(9, 'call_result', { callId: 'call-3', status: 'ok', member: 3 }),
      ],
      [
        row(5, 'system', { callId: 'call-2', member: 2 }),
        row(6, 'system', { callId: 'call-2', member: 3 }),
        row(7, 'system', { callId: 'call-3', member: 2 }),
      ],
    );
    expect(calls.map((call) => [call.callId, call.member])).toEqual([
      ['call-1', 1],
      ['call-2', 3],
      ['call-3', 3],
      ['call-4', null],
    ]);
  });

  it('counts only the FIRST settle of a call', () => {
    const [call] = foldRunCalls([
      row(1, 'call_started', { callId: 'call-1' }),
      row(2, 'call_result', { callId: 'call-1', status: 'ok' }),
      row(3, 'call_result', { callId: 'call-1', status: 'error', error: 'x' }),
    ]);
    expect(call!.status).toBe('completed');
  });
});

describe('foldRunDelegates', () => {
  const task = (seq: number, id: string, description: string): ItemWire =>
    row(seq, 'tool_call', {
      id,
      name: 'Task',
      input: { description, subagent_type: 'reviewer' },
    });
  const reply = (seq: number, id: string, isError = false): ItemWire =>
    row(seq, 'tool_result', { id, result: 'done', isError });
  const info = (
    seq: number,
    payload: Record<string, unknown>,
    nodeId = 'manager',
  ): ItemWire => row(seq, 'subagent_info', payload, nodeId);

  it('names a delegate from its launch and reads a returned one as completed', () => {
    const [delegate] = foldRunDelegates({
      declarations: [],
      launches: [task(1, 'toolu_a', 'Review bugs')],
      replies: [reply(2, 'toolu_a')],
      runSettled: false,
    });
    expect(delegate).toMatchObject({
      id: 'toolu_a',
      label: 'Review bugs',
      kind: 'reviewer',
      status: 'completed',
      launchSeq: 1,
    });
  });

  it('ranks a stated outcome over an open unit, and an open unit over the launch reply', () => {
    const delegates = foldRunDelegates({
      declarations: [
        info(3, { id: 'toolu_a', backgroundOpen: true }),
        info(4, { id: 'toolu_a', backgroundOutcome: 'stopped' }),
        info(5, { id: 'toolu_b', backgroundOpen: true }),
      ],
      launches: [task(1, 'toolu_a', 'A'), task(2, 'toolu_b', 'B')],
      // Both launches answered at once — an acknowledgement, not a report.
      replies: [reply(6, 'toolu_a'), reply(7, 'toolu_b')],
      runSettled: false,
    });
    expect(delegates.map((d) => [d.id, d.status])).toEqual([
      ['toolu_a', 'cancelled'],
      ['toolu_b', 'running'],
    ]);
  });

  it('admits a delegate the daemon declared without a named launch, merging its brief', () => {
    const [delegate] = foldRunDelegates({
      declarations: [
        info(1, { id: 'cursor-1', label: 'Review PR 6287' }, 'qa'),
        info(2, {
          id: 'cursor-1',
          label: null,
          backgroundOutcome: 'completed',
        }),
      ],
      launches: [],
      replies: [],
      runSettled: true,
    });
    expect(delegate).toMatchObject({
      id: 'cursor-1',
      nodeId: 'qa',
      label: 'Review PR 6287',
      status: 'completed',
    });
  });

  it('reads a stated failure, and an error reply, as failed', () => {
    const delegates = foldRunDelegates({
      declarations: [info(3, { id: 'toolu_a', backgroundOutcome: 'failed' })],
      launches: [task(1, 'toolu_a', 'A'), task(2, 'toolu_b', 'B')],
      replies: [reply(4, 'toolu_a'), reply(5, 'toolu_b', true)],
      runSettled: false,
    });
    expect(delegates.map((d) => [d.id, d.status])).toEqual([
      ['toolu_a', 'failed'],
      ['toolu_b', 'failed'],
    ]);
  });

  it('files a delegate under the call its launch was made in', () => {
    const [delegate] = foldRunDelegates({
      declarations: [],
      launches: [
        row(1, 'tool_call', {
          id: 'toolu_a',
          name: 'Task',
          input: { description: 'A' },
          callId: 'call-7',
        }),
      ],
      replies: [],
      runSettled: false,
    });
    expect(delegate!.callId).toBe('call-7');
  });

  const ref = {
    agentKind: 'claude',
    sessionId: 's',
    cwd: '/project',
    configDir: null,
    toolCallId: 'toolu_a',
    launchedAtMs: 1,
    childSessionId: null,
  };

  it('counts only a ref the recovery service would act on as recoverable', () => {
    const close = info(3, { id: 'toolu_a', backgroundOpen: false });
    const statusWith = (recovery: unknown) =>
      foldRunDelegates({
        declarations: [info(1, { id: 'toolu_a', recovery }), close],
        launches: [task(1, 'toolu_a', 'A')],
        replies: [],
        runSettled: true,
      })[0]!.status;

    expect(statusWith(ref)).toBe('untracked');
    // Missing fields, or a ref for another delegate, can never be read back.
    expect(statusWith({ agentKind: 'claude', toolCallId: 'toolu_a' })).toBe(
      'completed',
    );
    expect(statusWith({ ...ref, toolCallId: 'toolu_b' })).toBe('completed');
  });

  it('reads a recoverable close the launch reply failed as failed', () => {
    const [delegate] = foldRunDelegates({
      declarations: [
        info(1, { id: 'toolu_a', recovery: ref }),
        info(3, { id: 'toolu_a', backgroundOpen: false }),
      ],
      launches: [task(1, 'toolu_a', 'A')],
      replies: [reply(2, 'toolu_a', true)],
      runSettled: true,
    });
    expect(delegate!.status).toBe('failed');
  });

  it.each([undefined, null])(
    'keeps an outcome-less close of a recoverable delegate untracked despite a successful launch reply (%s)',
    (outcome) => {
      const [delegate] = foldRunDelegates({
        declarations: [
          info(1, { id: 'toolu_a', recovery: ref }),
          info(3, {
            id: 'toolu_a',
            backgroundOpen: false,
            backgroundOutcome: outcome,
          }),
        ],
        launches: [task(1, 'toolu_a', 'Review')],
        replies: [reply(2, 'toolu_a')],
        runSettled: false,
      });
      expect(delegate!.status).toBe('untracked');
    },
  );

  it('reads an outcome-less close with no recovery ref as it always read: completed, or failed on an error reply', () => {
    const close = (id: string): ItemWire =>
      info(5, { id, backgroundOpen: false });
    const delegates = foldRunDelegates({
      declarations: [close('toolu_a'), close('toolu_b'), close('toolu_c')],
      launches: [task(1, 'toolu_a', 'A'), task(2, 'toolu_b', 'B')],
      replies: [reply(3, 'toolu_b', true)],
      runSettled: true,
    });
    expect(delegates.map((d) => [d.id, d.status])).toEqual([
      ['toolu_a', 'completed'],
      ['toolu_b', 'failed'],
      ['toolu_c', 'completed'],
    ]);
  });

  it('stops counting a delegate as recoverable once its ref is withdrawn', () => {
    const [delegate] = foldRunDelegates({
      declarations: [
        info(1, { id: 'toolu_a', recovery: ref }),
        info(2, { id: 'toolu_a', recovery: null }),
        info(3, { id: 'toolu_a', backgroundOpen: false }),
      ],
      launches: [task(1, 'toolu_a', 'A')],
      replies: [],
      runSettled: true,
    });
    expect(delegate!.status).toBe('completed');
  });

  it('keeps tracking loss distinct from a reported stop and accepts a late report', () => {
    const declarations = [
      info(2, {
        id: 'toolu_a',
        backgroundOpen: false,
        backgroundOutcome: 'untracked',
      }),
    ];
    const input = {
      declarations,
      launches: [task(1, 'toolu_a', 'A')],
      replies: [reply(3, 'toolu_a')],
      runSettled: true,
    };
    expect(foldRunDelegates(input)[0]!.status).toBe('untracked');
    declarations.push(
      info(4, { id: 'toolu_a', backgroundOutcome: 'completed' }),
    );
    expect(foldRunDelegates(input)[0]!.status).toBe('completed');
    declarations.push(info(5, { id: 'toolu_a', backgroundOpen: true }));
    expect(foldRunDelegates(input)[0]!.status).toBe('running');
  });

  it('says a delegate’s process ended only while the close that said so still stands', () => {
    const declarations = [
      info(2, {
        id: 'toolu_a',
        backgroundOpen: false,
        backgroundOutcome: 'untracked',
        trackingLost: 'process-ended',
      }),
    ];
    const input = {
      declarations,
      launches: [task(1, 'toolu_a', 'A')],
      replies: [],
      runSettled: true,
    };
    expect(foldRunDelegates(input)[0]).toMatchObject({
      status: 'untracked',
      processEnded: true,
    });
    // Tracking lost while the process lived says nothing about it ending.
    declarations.push(
      info(3, {
        id: 'toolu_a',
        backgroundOpen: false,
        backgroundOutcome: 'untracked',
      }),
    );
    expect(foldRunDelegates(input)[0]!.processEnded).toBe(false);
    declarations.push(
      info(4, {
        id: 'toolu_a',
        backgroundOutcome: 'untracked',
        trackingLost: 'process-ended',
      }),
      info(5, { id: 'toolu_a', backgroundOutcome: 'completed' }),
    );
    expect(foldRunDelegates(input)[0]).toMatchObject({
      status: 'completed',
      processEnded: false,
    });
  });

  it('reads an unanswered recoverable launch as running until the run settles, then as untracked', () => {
    const input = {
      declarations: [info(1, { id: 'toolu_a', recovery: ref })],
      launches: [task(1, 'toolu_a', 'A')],
      replies: [],
    };
    expect(foldRunDelegates({ ...input, runSettled: false })[0]!.status).toBe(
      'running',
    );
    expect(foldRunDelegates({ ...input, runSettled: true })[0]!.status).toBe(
      'untracked',
    );
  });

  it('reads an unanswered launch with no recovery ref as cancelled once nothing more can come', () => {
    const [delegate] = foldRunDelegates({
      declarations: [],
      launches: [task(1, 'toolu_a', 'A')],
      replies: [],
      runSettled: true,
    });
    expect(delegate!.status).toBe('cancelled');
  });

  it('reads a delegate the user’s Stop cut off as cancelled, recoverable or not', () => {
    const declarations = [info(1, { id: 'toolu_a', recovery: ref })];
    const launches = [task(1, 'toolu_a', 'A')];
    const ending = (cancelled: boolean) => ({
      seq: 2,
      nodeId: 'manager',
      callId: null,
      cancelled,
    });
    const statusOf = (input: Partial<Parameters<typeof foldRunDelegates>[0]>) =>
      foldRunDelegates({
        declarations,
        launches,
        replies: [],
        runSettled: false,
        ...input,
      })[0]!.status;

    expect(statusOf({ endings: [ending(true)] })).toBe('cancelled');
    // A cancelled run that ended no turn of the delegate's (a team cancel).
    expect(statusOf({ runSettled: true, runCancelled: true })).toBe(
      'cancelled',
    );
    // A turn that finished or failed without its delegate's report.
    expect(statusOf({ endings: [ending(false)] })).toBe('untracked');
    // The delegate's OWN turn ending outranks what the run's latest turn did:
    // a Stop on a later turn ends nothing it launched before…
    expect(
      statusOf({
        endings: [ending(false)],
        runSettled: true,
        runCancelled: true,
      }),
    ).toBe('untracked');
    // …and a later turn completing does not undo the Stop that cut it off.
    expect(statusOf({ endings: [ending(true)], runSettled: true })).toBe(
      'cancelled',
    );
  });

  it('clears process-ended when the delegate is opened again', () => {
    const [delegate] = foldRunDelegates({
      declarations: [
        info(1, { id: 'toolu_a', recovery: ref }),
        info(2, {
          id: 'toolu_a',
          backgroundOpen: false,
          backgroundOutcome: 'untracked',
          trackingLost: 'process-ended',
        }),
        info(3, { id: 'toolu_a', backgroundOpen: true }),
        info(4, { id: 'toolu_a', backgroundOpen: false }),
      ],
      launches: [task(1, 'toolu_a', 'A')],
      replies: [],
      runSettled: true,
    });
    expect(delegate).toMatchObject({
      status: 'untracked',
      processEnded: false,
    });
  });
});
