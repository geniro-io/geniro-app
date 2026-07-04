import { io, type Socket } from 'socket.io-client';

import type { DaemonHandle, TerminalStatus } from '../shared/contracts';

export interface TerminalClientEvents {
  /**
   * Fired on every successful attach (first connect AND reconnects) with the
   * full buffered scrollback — the consumer resets its terminal and replays.
   */
  onSnapshot?: (
    snapshot: string,
    status: TerminalStatus,
    exitCode: number | null,
  ) => void;
  onData?: (data: string) => void;
  onExit?: (exitCode: number | null) => void;
  /** The attach targeted a session the daemon no longer knows (disposed/reaped). */
  onGone?: () => void;
  onClose?: () => void;
}

/**
 * Byte-plane client for one terminal session: the `/terminals` Socket.IO
 * namespace on the daemon's shared `/ws` engine.io instance. Auth mirrors
 * {@link DaemonClient} (per-launch token in the handshake `auth` payload).
 * Rooms are per-socket, so every (re)connect re-emits `attach` — the reply's
 * scrollback snapshot covers whatever bytes were missed while offline.
 */
export class TerminalClient {
  private socket: Socket | null = null;

  constructor(
    private readonly handle: DaemonHandle,
    private readonly terminalId: string,
    private readonly events: TerminalClientEvents,
  ) {}

  connect(): void {
    const socket = io(
      `http://${this.handle.host}:${this.handle.port}/terminals`,
      {
        path: '/ws',
        transports: ['websocket'],
        auth: { token: this.handle.token },
      },
    );
    this.socket = socket;

    socket.on('connect', () => {
      socket.emit('attach', { terminalId: this.terminalId });
    });
    socket.on('attached', (data: unknown) => {
      const payload = data as {
        terminalId?: unknown;
        snapshot?: unknown;
        status?: unknown;
        exitCode?: unknown;
        error?: unknown;
      } | null;
      if (payload?.terminalId !== this.terminalId) {
        return;
      }
      if (payload.error !== undefined) {
        // The daemon replied with our id + an error (unknown/reaped session):
        // surface it instead of leaving the panel on a stale "live" badge.
        this.events.onGone?.();
        return;
      }
      this.events.onSnapshot?.(
        typeof payload.snapshot === 'string' ? payload.snapshot : '',
        payload.status === 'exited' || payload.status === 'closing'
          ? payload.status
          : 'running',
        typeof payload.exitCode === 'number' ? payload.exitCode : null,
      );
    });
    socket.on('terminal_data', (data: unknown) => {
      const payload = data as { terminalId?: unknown; data?: unknown } | null;
      if (
        payload?.terminalId === this.terminalId &&
        typeof payload.data === 'string'
      ) {
        this.events.onData?.(payload.data);
      }
    });
    socket.on('terminal_exit', (data: unknown) => {
      const payload = data as {
        terminalId?: unknown;
        exitCode?: unknown;
      } | null;
      if (payload?.terminalId === this.terminalId) {
        this.events.onExit?.(
          typeof payload.exitCode === 'number' ? payload.exitCode : null,
        );
      }
    });
    socket.on('disconnect', () => this.events.onClose?.());
  }

  /** Forward keystrokes/paste from xterm to the PTY. */
  input(data: string): void {
    this.socket?.emit('input', { terminalId: this.terminalId, data });
  }

  /** Propagate the fitted xterm dimensions to the PTY. */
  resize(cols: number, rows: number): void {
    this.socket?.emit('resize', { terminalId: this.terminalId, cols, rows });
  }

  /** Detach (the PTY keeps running for a later re-attach) and disconnect. */
  close(): void {
    this.socket?.emit('detach', { terminalId: this.terminalId });
    this.socket?.close();
    this.socket = null;
  }
}
