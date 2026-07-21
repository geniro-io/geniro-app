import { io, type Socket } from 'socket.io-client';

import { type ChatItem, type DaemonHandle } from '../shared/contracts';

export interface DaemonClientEvents {
  onOpen?: () => void;
  onMessage?: (event: string, data: unknown) => void;
  onClose?: () => void;
}

/**
 * TWIN PARSER: mirrors the `verdict_ack` reply shape produced by the daemon's
 * `NotificationsGateway.verdict`
 * (apps/daemon/src/v1/notifications/gateways/notifications.gateway.ts) — no
 * daemon↔renderer shared package exists, so a shape change there must be
 * mirrored here, and vice versa.
 */
export interface VerdictAck {
  runId: string | null;
  requestId: string | null;
  status: 'applied' | 'expired' | 'invalid';
}

const JOIN_TIMEOUT_MS = 5_000;

interface JoinWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
export class DaemonClient {
  private socket: Socket | null = null;
  private readonly itemListeners = new Set<(item: ChatItem) => void>();
  private readonly reconnectListeners = new Set<(error?: Error) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private readonly verdictAckListeners = new Set<(ack: VerdictAck) => void>();
  private readonly joinWaiters = new Map<string, Set<JoinWaiter>>();
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
      let joined: Promise<void> | null = null;
      if (this.activeRunId) {
        if (isReconnect) {
          joined = this.waitForJoin(this.activeRunId);
        }
        socket.emit('join', { runId: this.activeRunId });
      }
      this.events.onOpen?.();
      if (isReconnect) {
        void (joined ?? Promise.resolve())
          .then(() => {
            for (const listener of this.reconnectListeners) {
              listener();
            }
          })
          .catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            for (const listener of this.reconnectListeners) {
              listener(error);
            }
          });
      }
    });
    socket.on('disconnect', () => {
      this.rejectAllJoins('socket disconnected before joining run');
      for (const listener of this.disconnectListeners) {
        listener();
      }
      this.events.onClose?.();
    });
    socket.onAny((event: string, data: unknown) => {
      this.events.onMessage?.(event, data);
      if (event === 'joined') {
        this.resolveJoined(data);
      }
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
   * Subscribe to verdict acknowledgments. Only `expired` means the request
   * already settled; `invalid` remains retryable.
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
  onReconnect(listener: (error?: Error) => void): () => void {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  /** Join a run's room to start receiving its `item` events. */
  joinRun(runId: string): Promise<void> {
    this.activeRunId = runId;
    const joined = this.waitForJoin(runId);
    if (this.socket?.connected) {
      this.socket.emit('join', { runId });
    }
    return joined;
  }

  /** Leave a run's room. */
  leaveRun(runId: string): void {
    if (this.activeRunId === runId) {
      this.activeRunId = null;
    }
    this.rejectJoins(runId, 'run room was left before joining');
    this.socket?.emit('leave', { runId });
  }

  /**
   * Answer an `ask`-node's approval card. The durable acknowledgment is the
   * `approval_verdict` item the daemon persists-then-emits back to the room;
   * the immediate `verdict_ack` reply only reports routing (`expired` means
   * already settled; `invalid` remains retryable).
   * `answer` carries the user's picked option / typed text for a question
   * card (AskUserQuestion) — omitted for plain tool approvals.
   *
   * TWIN PARSER: the daemon parses this `verdict` envelope in
   * `extractVerdict`
   * (apps/daemon/src/v1/notifications/gateways/notifications.gateway.ts) —
   * `{runId, requestId, allow, answer?}`, `answer` honored only as a
   * non-empty string ≤ MAX_ANSWER_LENGTH. A shape change here must be
   * mirrored there, and vice versa.
   */
  sendVerdict(
    runId: string,
    requestId: string,
    allow: boolean,
    answer?: string,
  ): void {
    this.socket?.emit('verdict', {
      runId,
      requestId,
      allow,
      ...(answer !== undefined ? { answer } : {}),
    });
  }

  close(): void {
    this.rejectAllJoins('socket closed before joining run');
    this.socket?.close();
    this.socket = null;
  }

  private waitForJoin(runId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter: JoinWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeJoinWaiter(runId, waiter);
          reject(new Error(`timed out joining run ${runId}`));
        }, JOIN_TIMEOUT_MS),
      };
      const waiters = this.joinWaiters.get(runId) ?? new Set<JoinWaiter>();
      waiters.add(waiter);
      this.joinWaiters.set(runId, waiters);
    });
  }

  private resolveJoined(data: unknown): void {
    const runId =
      typeof data === 'object' &&
      data !== null &&
      typeof (data as { runId?: unknown }).runId === 'string'
        ? (data as { runId: string }).runId
        : null;
    if (!runId) {
      return;
    }
    const waiters = this.joinWaiters.get(runId);
    if (!waiters) {
      return;
    }
    this.joinWaiters.delete(runId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectJoins(runId: string, message: string): void {
    const waiters = this.joinWaiters.get(runId);
    if (!waiters) {
      return;
    }
    this.joinWaiters.delete(runId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
  }

  private rejectAllJoins(message: string): void {
    for (const runId of [...this.joinWaiters.keys()]) {
      this.rejectJoins(runId, message);
    }
  }

  private removeJoinWaiter(runId: string, waiter: JoinWaiter): void {
    const waiters = this.joinWaiters.get(runId);
    if (!waiters) {
      return;
    }
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.joinWaiters.delete(runId);
    }
  }
}
