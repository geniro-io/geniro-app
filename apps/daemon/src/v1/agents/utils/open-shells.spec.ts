import { describe, expect, it } from 'vitest';

import {
  isDelegateCall,
  launchingCallOf,
  type ShellRow,
  strandedShells,
} from './open-shells';

const open = (
  id: string | null,
  workId: string,
  extra: Record<string, unknown> = {},
  nodeId: string | null = null,
): ShellRow => ({
  kind: 'shell_open',
  payload: JSON.stringify({ id, workId, ...extra }),
  nodeId,
});
const close = (
  id: string | null,
  workId: string,
  nodeId: string | null = null,
): ShellRow => ({
  kind: 'shell_info',
  payload: JSON.stringify({ id, workId }),
  nodeId,
});

describe('strandedShells', () => {
  it('answers the commands opened and never closed', () => {
    expect(
      strandedShells([
        open('t1', 'b1'),
        open('t2', 'b2'),
        close('t2', 'b2'),
      ]).map((shell) => shell.workId),
    ).toEqual(['b1']);
  });

  it('matches a close by its launching call when it names one', () => {
    // The call is the stronger key: a close naming it is about that shell
    // whatever work id it carries alongside.
    expect(strandedShells([open('t1', 'b1'), close('t1', 'other')])).toEqual(
      [],
    );
  });

  it('matches a close by the work id when it names no call', () => {
    expect(strandedShells([open('t1', 'b1'), close(null, 'b1')])).toEqual([]);
  });

  it('keeps where the open row was filed, so the close can be filed there too', () => {
    expect(
      strandedShells([open('t1', 'b1', { callId: 'call-2' }, 'engineer')]),
    ).toEqual([
      { toolCallId: 't1', workId: 'b1', nodeId: 'engineer', callId: 'call-2' },
    ]);
  });

  it('keeps two nodes’ shells apart when their per-process work ids collide', () => {
    expect(
      strandedShells([
        open('t1', 'bash_1', {}, 'engineer'),
        open('t1', 'bash_1', {}, 'qa'),
        close('t1', 'bash_1', 'engineer'),
      ]).map((shell) => shell.nodeId),
    ).toEqual(['qa']);
  });

  it('skips a row it cannot read rather than throwing', () => {
    expect(
      strandedShells([
        { kind: 'shell_open', payload: 'not json', nodeId: null },
        open('t1', 'b1'),
      ]).map((shell) => shell.workId),
    ).toEqual(['b1']);
  });
});

describe('launchingCallOf', () => {
  const call = (
    command: string,
    extra: Record<string, unknown> = {},
    nodeId: string | null = 'dev',
  ) => ({
    payload: JSON.stringify({ id: 't1', input: { command }, ...extra }),
    nodeId,
  });
  const shell = { toolCallId: 't1', nodeId: 'dev', callId: 'call-A' };

  it('takes the newest call by that id under the same node and workflow call', () => {
    // An ACP CLI numbers calls per session: other conversations reuse `t1`.
    const calls = [
      call('pnpm older', { callId: 'call-A' }),
      call('pnpm dev', { callId: 'call-A' }),
      call('pnpm other-call', { callId: 'call-B' }),
      call('pnpm other-node', { callId: 'call-A' }, 'review'),
    ];
    expect(launchingCallOf(shell, calls)).toBe(calls[1]);
  });

  it("prefers the agent's own call over a delegate's, and falls back to it", () => {
    const own = call('pnpm dev', { callId: 'call-A' });
    const delegate = call('pnpm delegate', {
      callId: 'call-A',
      parentToolUseId: 'task-1',
    });
    expect(launchingCallOf(shell, [own, delegate])).toBe(own);
    expect(launchingCallOf(shell, [delegate])).toBe(delegate);
    expect(isDelegateCall(delegate)).toBe(true);
    expect(isDelegateCall(own)).toBe(false);
  });

  it('pairs a chat shell, which has no workflow call, with a call that has none', () => {
    const chat = { toolCallId: 't1', nodeId: null, callId: null };
    const calls = [
      call('pnpm dev', {}, null),
      call('x', { callId: 'c' }, null),
    ];
    expect(launchingCallOf(chat, calls)).toBe(calls[0]);
    expect(
      launchingCallOf({ ...chat, toolCallId: null }, calls),
    ).toBeUndefined();
  });
});
