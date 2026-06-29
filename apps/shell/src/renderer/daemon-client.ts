import { DAEMON_HOST, type DaemonHandle } from '@packages/types';

export interface DaemonClientEvents {
  onOpen?: () => void;
  onMessage?: (message: unknown) => void;
  onClose?: () => void;
}

const RECONNECT_DELAY_MS = 1000;

/**
 * Thin WebSocket client to the loopback daemon. Authenticates with the
 * per-launch token (query param — browsers can't set WS headers) and
 * auto-reconnects until explicitly closed. M1 uses it to prove the
 * renderer ⇄ daemon channel; real event streams arrive in M2.
 */
export class DaemonClient {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private reconnectTimer: number | null = null;

  constructor(
    private readonly handle: DaemonHandle,
    private readonly events: DaemonClientEvents,
  ) {}

  connect(): void {
    const url = `ws://${DAEMON_HOST}:${this.handle.port}/ws?token=${encodeURIComponent(
      this.handle.token,
    )}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => this.events.onOpen?.();
    ws.onmessage = (event) => {
      try {
        this.events.onMessage?.(JSON.parse(String(event.data)));
      } catch {
        // ignore non-JSON frames
      }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      this.events.onClose?.();
      if (!this.closedByUser) {
        this.scheduleReconnect();
      }
    };
  }

  send(data: string): void {
    this.ws?.send(data);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }
}
