import { io, type Socket } from 'socket.io-client';

import { type DaemonHandle } from '../shared/contracts';

export interface DaemonClientEvents {
  onOpen?: () => void;
  onMessage?: (event: string, data: unknown) => void;
  onClose?: () => void;
}

/**
 * Thin Socket.IO client to the loopback daemon. Authenticates with the
 * per-launch token via the handshake `auth` payload (browsers can't set WS
 * headers) and lets Socket.IO own reconnection. Forces the `websocket`
 * transport — no HTTP long-polling fallback is needed on loopback. M1 uses it
 * to prove the renderer ⇄ daemon channel (hello + echo); real event streams
 * arrive in M2.
 */
export class DaemonClient {
  private socket: Socket | null = null;

  constructor(
    private readonly handle: DaemonHandle,
    private readonly events: DaemonClientEvents,
  ) {}

  connect(): void {
    const socket = io(`http://${this.handle.host}:${this.handle.port}`, {
      path: '/ws',
      transports: ['websocket'],
      auth: { token: this.handle.token },
    });
    this.socket = socket;

    socket.on('connect', () => this.events.onOpen?.());
    socket.on('disconnect', () => this.events.onClose?.());
    socket.onAny((event: string, data: unknown) =>
      this.events.onMessage?.(event, data),
    );
  }

  send(data: string): void {
    this.socket?.emit('echo', data);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
