import { io, type Socket } from 'socket.io-client';

import { type ChatItem, type DaemonHandle } from '../shared/contracts';

export interface DaemonClientEvents {
  onOpen?: () => void;
  onMessage?: (event: string, data: unknown) => void;
  onClose?: () => void;
}

/**
 * Thin Socket.IO client to the loopback daemon. Authenticates with the
 * per-launch token via the handshake `auth` payload (browsers can't set WS
 * headers) and lets Socket.IO own reconnection. Forces the `websocket`
 * transport — no HTTP long-polling fallback is needed on loopback. M2 grows it
 * from the M1 hello/echo proof into the live run-event channel: `join`/`leave`
 * a run's room and receive its persisted `item` events.
 *
 * Socket.IO rooms are per-socket and server-side, so a transient
 * disconnect/reconnect lands a fresh socket id in NO rooms. The client tracks
 * the active run and re-emits `join` on every (re)connect, and fires
 * `onReconnect` so the renderer can fetch the items it missed while offline
 * (the room buffers nothing for an absent member).
 */
export interface VerdictAck {
  requestId: string | null;
  applied: boolean;
}

export class DaemonClient {
  private socket: Socket | null = null;
  private readonly itemListeners = new Set<(item: ChatItem) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly verdictAckListeners = new Set<(ack: VerdictAck) => void>();
  private activeRunId: string | null = null;
  private hasConnected = false;

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

    socket.on('connect', () => {
      const isReconnect = this.hasConnected;
      this.hasConnected = true;
      // Re-join the active run's room so live items resume after a reconnect.
      if (this.activeRunId) {
        socket.emit('join', { runId: this.activeRunId });
      }
      this.events.onOpen?.();
      if (isReconnect) {
        for (const listener of this.reconnectListeners) {
          listener();
        }
      }
    });
    socket.on('disconnect', () => this.events.onClose?.());
    socket.onAny((event: string, data: unknown) => {
      this.events.onMessage?.(event, data);
      if (event === 'item') {
        const item = data as ChatItem;
        for (const listener of this.itemListeners) {
          listener(item);
        }
      }
      if (event === 'verdict_ack') {
        const ack = data as VerdictAck;
        for (const listener of this.verdictAckListeners) {
          listener(ack);
        }
      }
    });
  }

  /**
   * Subscribe to verdict acknowledgments. `applied: false` means the request
   * already settled (the node's turn ended first) — the card shows expired.
   */
  onVerdictAck(listener: (ack: VerdictAck) => void): () => void {
    this.verdictAckListeners.add(listener);
    return () => {
      this.verdictAckListeners.delete(listener);
    };
  }

  /** Subscribe to streamed run items; returns an unsubscribe function. */
  onItem(listener: (item: ChatItem) => void): () => void {
    this.itemListeners.add(listener);
    return () => {
      this.itemListeners.delete(listener);
    };
  }

  /**
   * Subscribe to reconnects (not the first connect); returns an unsubscribe
   * function. The renderer uses this to fetch items missed while offline.
   */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  /** Join a run's room to start receiving its `item` events. */
  joinRun(runId: string): void {
    this.activeRunId = runId;
    this.socket?.emit('join', { runId });
  }

  /** Leave a run's room. */
  leaveRun(runId: string): void {
    if (this.activeRunId === runId) {
      this.activeRunId = null;
    }
    this.socket?.emit('leave', { runId });
  }

  /**
   * Answer an `ask`-node's approval card. The durable acknowledgment is the
   * `approval_verdict` item the daemon persists-then-emits back to the room;
   * the immediate `verdict_ack` reply only reports routing (`applied: false`
   * = the request already settled, e.g. the node's turn ended first).
   */
  sendVerdict(runId: string, requestId: string, allow: boolean): void {
    this.socket?.emit('verdict', { runId, requestId, allow });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
