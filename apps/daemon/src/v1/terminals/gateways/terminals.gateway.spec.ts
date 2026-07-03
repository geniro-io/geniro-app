import type { Namespace, Socket } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeInfo } from '../../../auth/runtime';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { type PtyLike, PtyService } from '../services/pty.service';
import { TerminalsGateway } from './terminals.gateway';

const runtime: RuntimeInfo = {
  token: 'good-token',
  version: '9.9.9',
  startedAt: 0,
};

class FakePty implements PtyLike {
  pid = 4242;
  written: string[] = [];
  resized: [number, number][] = [];
  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((e: { exitCode: number }) => void)[] = [];

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(listener);
    return { dispose: () => {} };
  }
  onExit(listener: (e: { exitCode: number }) => void): { dispose(): void } {
    this.exitListeners.push(listener);
    return { dispose: () => {} };
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }
  kill(): void {}

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }
  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode });
    }
  }
}

function fakeSocket(token: unknown) {
  return {
    handshake: { auth: { token } },
    emit: vi.fn(),
    disconnect: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
  };
}

function build() {
  const ptys: FakePty[] = [];
  const service = new PtyService(new ProcessRegistry(), {
    spawnPty: () => {
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    },
  });
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const gw = new TerminalsGateway(runtime, service);
  Object.assign(gw as unknown as Record<string, unknown>, {
    namespace: { to } as unknown as Namespace,
  });
  const wire = service.create({
    runId: 'run-1',
    nodeId: null,
    command: 'claude',
    args: [],
    cwd: '/tmp',
  });
  return { gw, service, ptys, to, emit, terminalId: wire.id };
}

describe('TerminalsGateway', () => {
  it('disconnects a socket presenting a bad token', () => {
    const { gw } = build();
    const socket = fakeSocket('wrong');

    gw.handleConnection(socket as unknown as Socket);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('accepts the per-launch token', () => {
    const { gw } = build();
    const socket = fakeSocket('good-token');

    gw.handleConnection(socket as unknown as Socket);

    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('attach replies with the scrollback snapshot and joins the room', () => {
    const { gw, ptys, terminalId } = build();
    ptys[0]?.emitData('history');
    const socket = fakeSocket('good-token');

    const reply = gw.attach(socket as unknown as Socket, { terminalId });

    expect(reply.data).toMatchObject({
      terminalId,
      snapshot: 'history',
      status: 'running',
    });
    expect(socket.join).toHaveBeenCalledWith(`terminal:${terminalId}`);
  });

  it('attach on an unknown terminal echoes the id with an error and joins nothing', () => {
    const { gw } = build();
    const socket = fakeSocket('good-token');

    const reply = gw.attach(socket as unknown as Socket, {
      terminalId: 'nope',
    });

    // The requested id comes back so the client can tell "MY session is gone"
    // apart from a reply meant for another terminal (which it filters out).
    expect(reply.data).toEqual({
      terminalId: 'nope',
      error: 'TERMINAL_NOT_FOUND',
    });
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('attach to an exited session replays the final screen without a live fan-out', () => {
    const { gw, service, ptys, emit, terminalId } = build();
    ptys[0]?.emitData('final screen');
    ptys[0]?.emitExit(0);
    const socket = fakeSocket('good-token');

    const reply = gw.attach(socket as unknown as Socket, { terminalId });

    expect(reply.data).toMatchObject({
      terminalId,
      snapshot: 'final screen',
      status: 'exited',
      exitCode: 0,
    });
    // The session's stream already completed — nothing may be fanned out, and
    // a second attach must behave identically (no stranded subscription).
    gw.attach(fakeSocket('good-token') as unknown as Socket, { terminalId });
    expect(emit).not.toHaveBeenCalled();
    expect(service.get(terminalId).status).toBe('exited');
  });

  it('repeated attaches share ONE fan-out — bytes reach the room exactly once', () => {
    const { gw, ptys, emit, terminalId } = build();
    // Re-attach on reconnect is the NORMAL protocol, so a second attach for
    // the same session must not add a second subscription (double output).
    gw.attach(fakeSocket('good-token') as unknown as Socket, { terminalId });
    gw.attach(fakeSocket('good-token') as unknown as Socket, { terminalId });

    ptys[0]?.emitData('once');

    const dataEmits = emit.mock.calls.filter(
      ([event]) => event === 'terminal_data',
    );
    expect(dataEmits).toHaveLength(1);
  });

  it('forwards a well-formed resize and drops non-finite dimensions', () => {
    const { gw, ptys, terminalId } = build();

    gw.resize({ terminalId, cols: 120, rows: 40 });
    gw.resize({ terminalId, cols: Number.NaN, rows: 40 });
    gw.resize({ terminalId, cols: Number.POSITIVE_INFINITY, rows: 40 });
    gw.resize({ terminalId, cols: '120', rows: 40 });
    gw.resize('garbage');

    expect(ptys[0]?.resized).toEqual([[120, 40]]);
  });

  it('fans live data and exit out to the terminal room', () => {
    const { gw, ptys, to, emit, terminalId } = build();
    const socket = fakeSocket('good-token');
    gw.attach(socket as unknown as Socket, { terminalId });

    ptys[0]?.emitData('live-bytes');
    ptys[0]?.emitExit(0);

    expect(to).toHaveBeenCalledWith(`terminal:${terminalId}`);
    expect(emit).toHaveBeenCalledWith('terminal_data', {
      terminalId,
      data: 'live-bytes',
    });
    expect(emit).toHaveBeenCalledWith('terminal_exit', {
      terminalId,
      exitCode: 0,
    });
  });

  it('routes input to the pty and ignores malformed payloads', () => {
    const { gw, ptys, terminalId } = build();

    gw.input({ terminalId, data: 'ls\r' });
    gw.input({ terminalId, data: 42 });
    gw.input('garbage');

    expect(ptys[0]?.written).toEqual(['ls\r']);
  });

  it('detach leaves the room without killing the session', () => {
    const { gw, service, terminalId } = build();
    const socket = fakeSocket('good-token');

    const reply = gw.detach(socket as unknown as Socket, { terminalId });

    expect(socket.leave).toHaveBeenCalledWith(`terminal:${terminalId}`);
    expect(reply.data).toEqual({ terminalId });
    expect(service.get(terminalId).status).toBe('running');
  });
});
