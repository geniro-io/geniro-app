import type { Server, Socket } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeInfo } from '../../../auth/runtime';
import type { ItemWire } from '../../agents/chat.types';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import { NotificationsGateway } from './notifications.gateway';

const runtime: RuntimeInfo = {
  token: 'good-token',
  version: '9.9.9',
  startedAt: 0,
};

function fakeSocket(token: unknown): {
  handshake: { auth: { token: unknown } };
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
} {
  return {
    handshake: { auth: { token } },
    emit: vi.fn(),
    disconnect: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
  };
}

function wireItem(runId: string, seq: number): ItemWire {
  return {
    id: `i-${seq}`,
    runId,
    nodeId: null,
    seq,
    kind: 'message',
    role: 'assistant',
    payload: { text: 'hi' },
    createdAt: new Date(0).toISOString(),
  };
}

describe('NotificationsGateway', () => {
  it('disconnects a socket presenting a bad token and never says hello', () => {
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
    );
    const socket = fakeSocket('wrong-token');

    gw.handleConnection(socket as unknown as Socket);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('greets a socket presenting the per-launch token', () => {
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
    );
    const socket = fakeSocket('good-token');

    gw.handleConnection(socket as unknown as Socket);

    expect(socket.emit).toHaveBeenCalledWith('hello', {
      version: runtime.version,
    });
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('join reads the runId from {runId} and string payloads, ignores empty', async () => {
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
    );
    const socket = fakeSocket('good-token');

    await expect(
      gw.join(socket as unknown as Socket, { runId: 'r1' }),
    ).resolves.toEqual({
      event: 'joined',
      data: { runId: 'r1' },
    });
    expect(socket.join).toHaveBeenCalledWith('run:r1');

    await expect(gw.join(socket as unknown as Socket, 'r2')).resolves.toEqual({
      event: 'joined',
      data: { runId: 'r2' },
    });
    expect(socket.join).toHaveBeenCalledWith('run:r2');

    // An empty/garbage payload yields a null runId and joins no room.
    await expect(
      gw.join(socket as unknown as Socket, { runId: '' }),
    ).resolves.toEqual({
      event: 'joined',
      data: { runId: null },
    });
    expect(socket.join).toHaveBeenCalledTimes(2);
  });

  it('does not acknowledge joined until Socket.IO room membership completes', async () => {
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
    );
    const socket = fakeSocket('good-token');
    let resolveJoin!: () => void;
    socket.join.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveJoin = resolve;
      }),
    );
    let settled = false;
    const response = gw
      .join(socket as unknown as Socket, { runId: 'r1' })
      .finally(() => {
        settled = true;
      });

    await Promise.resolve();
    expect(settled).toBe(false);
    resolveJoin();
    await expect(response).resolves.toEqual({
      event: 'joined',
      data: { runId: 'r1' },
    });
  });

  it('leave reads the runId and leaves the room', () => {
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
    );
    const socket = fakeSocket('good-token');

    expect(gw.leave(socket as unknown as Socket, { runId: 'r1' })).toEqual({
      event: 'left',
      data: { runId: 'r1' },
    });
    expect(socket.leave).toHaveBeenCalledWith('run:r1');
  });

  it('isolates a per-emit failure so the bus subscription survives', () => {
    const bus = new AgentEventBus();
    const gw = new NotificationsGateway(runtime, bus, new ApprovalRegistry());
    let calls = 0;
    const emit = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        throw new Error('emit boom'); // a single bad emit must not kill the sub
      }
    });
    const server = { to: vi.fn(() => ({ emit })) } as unknown as Server;
    gw.afterInit(server);

    // The first publish throws inside emit — it must be caught, not propagate.
    expect(() =>
      bus.publish({ runId: 'r1', item: wireItem('r1', 0) }),
    ).not.toThrow();
    // The subscription is still alive: a second publish is still delivered.
    bus.publish({ runId: 'r2', item: wireItem('r2', 1) });

    expect(server.to).toHaveBeenCalledWith('run:r1');
    expect(server.to).toHaveBeenCalledWith('run:r2');
    expect(emit).toHaveBeenCalledTimes(2);

    gw.onModuleDestroy();
  });
});

describe('verdict round-trip', () => {
  const runtime = {
    token: 't',
    version: '0',
  } as unknown as import('../../../auth/runtime').RuntimeInfo;

  it('routes a valid verdict to the approval registry and acks applied', () => {
    const approvals = new ApprovalRegistry();
    const respond = vi.fn(() => true);
    approvals.track({
      runId: 'r1',
      nodeId: 'n1',
      requestId: 'req-1',
      toolName: 'Write',
      input: {},
      respond,
    });
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      approvals,
    );

    const ack = gw.verdict({ runId: 'r1', requestId: 'req-1', allow: true });
    expect(ack).toEqual({
      event: 'verdict_ack',
      data: { runId: 'r1', requestId: 'req-1', status: 'applied' },
    });
    expect(respond).toHaveBeenCalledWith(true);
  });

  it('distinguishes expired requests from malformed verdicts', () => {
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      new ApprovalRegistry(),
    );
    expect(
      gw.verdict({ runId: 'r1', requestId: 'ghost', allow: false }).data,
    ).toEqual({ runId: 'r1', requestId: 'ghost', status: 'expired' });
    expect(gw.verdict({ nonsense: true }).data).toEqual({
      runId: null,
      requestId: null,
      status: 'invalid',
    });
  });

  it('forwards valid answers and rejects invalid ones without consuming the question', () => {
    const approvals = new ApprovalRegistry();
    const respond = vi.fn(() => true);
    const track = (requestId: string): void =>
      approvals.track({
        runId: 'r1',
        nodeId: 'n1',
        requestId,
        toolName: 'AskUserQuestion',
        input: {},
        respond,
      });
    const gw = new NotificationsGateway(
      runtime,
      new AgentEventBus(),
      approvals,
    );

    track('req-a');
    gw.verdict({
      runId: 'r1',
      requestId: 'req-a',
      allow: true,
      answer: 'Blue',
    });
    expect(respond).toHaveBeenLastCalledWith(true, 'Blue');

    // Non-string / empty / oversize answers must not consume the one-shot
    // approval as a plain approve; the user can correct and resubmit.
    track('req-b');
    expect(
      gw.verdict({
        runId: 'r1',
        requestId: 'req-b',
        allow: true,
        answer: 42,
      }).data,
    ).toEqual({ runId: 'r1', requestId: 'req-b', status: 'invalid' });
    track('req-c');
    expect(
      gw.verdict({
        runId: 'r1',
        requestId: 'req-c',
        allow: true,
        answer: '',
      }).data,
    ).toEqual({ runId: 'r1', requestId: 'req-c', status: 'invalid' });
    track('req-d');
    expect(
      gw.verdict({
        runId: 'r1',
        requestId: 'req-d',
        allow: true,
        answer: 'x'.repeat(40_000),
      }).data,
    ).toEqual({ runId: 'r1', requestId: 'req-d', status: 'invalid' });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(approvals.listByRun('r1')).toHaveLength(3);
  });
});
