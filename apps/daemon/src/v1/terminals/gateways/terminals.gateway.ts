import { Inject, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type WsResponse,
} from '@nestjs/websockets';
import type { Subscription } from 'rxjs';
import type { Namespace, Socket } from 'socket.io';

import { RUNTIME_TOKEN, type RuntimeInfo } from '../../../auth/runtime';
import { enforceWsHandshakeAuth } from '../../../auth/ws-auth';
import { extractStringField } from '../../agents/utils/ws-payload';
import { PtyService } from '../services/pty.service';
import type { TerminalStatus } from '../terminals.types';

/** Socket.IO room fanning one terminal session's bytes to attached clients. */
function terminalRoom(terminalId: string): string {
  return `terminal:${terminalId}`;
}

/** Read a `{terminalId}` (or bare string) payload. */
function extractTerminalId(data: unknown): string | null {
  return extractStringField(data, 'terminalId');
}

/**
 * Live PTY byte channel. Rides the SAME engine.io instance as the
 * notifications gateway (`path: '/ws'`) as the `/terminals` namespace — a
 * second server would double the auth surface and the listen socket. Auth
 * mirrors `NotificationsGateway`: per-launch token in the handshake `auth`
 * payload, constant-time compare, disconnect on mismatch.
 *
 * Attach protocol: the reply carries the buffered scrollback snapshot and the
 * client joins the session room in the same synchronous tick, so no byte can
 * fall between the snapshot and the live stream. Detach only leaves the room —
 * the PTY keeps running for a later re-attach; kill is the REST DELETE.
 */
@WebSocketGateway({
  path: '/ws',
  namespace: '/terminals',
  cors: { origin: '*' },
})
export class TerminalsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(TerminalsGateway.name);
  /** Lazily created per-session fan-out from the PTY stream to its room. */
  private readonly fanouts = new Map<string, Subscription>();

  @WebSocketServer()
  private readonly namespace!: Namespace;

  constructor(
    @Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo,
    private readonly pty: PtyService,
  ) {}

  handleConnection(client: Socket): void {
    // Mirror the sibling NotificationsGateway: branch on the guard's verdict so
    // anything added after it can never run for a rejected socket.
    if (!enforceWsHandshakeAuth(client, this.runtime)) {
      return;
    }
  }

  @SubscribeMessage('attach')
  attach(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): WsResponse<{
    terminalId: string | null;
    snapshot?: string;
    status?: TerminalStatus;
    exitCode?: number | null;
    error?: string;
  }> {
    const terminalId = extractTerminalId(data);
    if (!terminalId) {
      return { event: 'attached', data: { terminalId: null } };
    }
    try {
      const session = this.pty.get(terminalId);
      const snapshot = this.pty.scrollback(terminalId);
      this.ensureFanout(terminalId);
      void client.join(terminalRoom(terminalId));
      return {
        event: 'attached',
        data: {
          terminalId,
          snapshot,
          status: session.status,
          exitCode: session.exitCode,
        },
      };
    } catch {
      // Unknown/reaped session (pty.get throws TERMINAL_NOT_FOUND) — echo the
      // requested id back with an error so the client can show "session gone"
      // instead of leaving a blank panel wearing a stale "live" badge.
      return {
        event: 'attached',
        data: { terminalId, error: 'TERMINAL_NOT_FOUND' },
      };
    }
  }

  @SubscribeMessage('detach')
  detach(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): WsResponse<{ terminalId: string | null }> {
    const terminalId = extractTerminalId(data);
    if (terminalId) {
      void client.leave(terminalRoom(terminalId));
    }
    return { event: 'detached', data: { terminalId } };
  }

  @SubscribeMessage('input')
  input(@MessageBody() data: unknown): void {
    if (!data || typeof data !== 'object') {
      return;
    }
    const terminalId = extractTerminalId(data);
    const payload = (data as { data?: unknown }).data;
    if (terminalId && typeof payload === 'string') {
      try {
        this.pty.write(terminalId, payload);
      } catch {
        // Session gone — the client learns via the missing room traffic.
      }
    }
  }

  @SubscribeMessage('resize')
  resize(@MessageBody() data: unknown): void {
    if (!data || typeof data !== 'object') {
      return;
    }
    const terminalId = extractTerminalId(data);
    const { cols, rows } = data as { cols?: unknown; rows?: unknown };
    if (
      terminalId &&
      typeof cols === 'number' &&
      Number.isFinite(cols) &&
      typeof rows === 'number' &&
      Number.isFinite(rows)
    ) {
      try {
        this.pty.resize(terminalId, cols, rows);
      } catch {
        // Session gone — resize is best-effort.
      }
    }
  }

  /**
   * One subscription per session, shared by every attached client. Cleans
   * itself up when the PTY exits (the service completes the stream).
   */
  private ensureFanout(terminalId: string): void {
    if (this.fanouts.has(terminalId)) {
      return;
    }
    const room = terminalRoom(terminalId);
    const subscription = this.pty.stream(terminalId).subscribe({
      // Note: an already-exited session's Subject is complete, so `complete`
      // below fires synchronously DURING subscribe — before the `set` at the
      // end of this method. The `subscription.closed` guard after subscribe is
      // what prevents a closed subscription being stranded in the map.
      next: (event) => {
        try {
          if (event.kind === 'data') {
            this.namespace.to(room).emit('terminal_data', {
              terminalId,
              data: event.data,
            });
          } else {
            this.namespace.to(room).emit('terminal_exit', {
              terminalId,
              exitCode: event.exitCode,
            });
          }
        } catch (err) {
          this.logger.error(
            `failed to emit to ${room}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      complete: () => {
        this.fanouts.delete(terminalId);
      },
      error: () => {
        this.fanouts.delete(terminalId);
      },
    });
    // Only track a still-open subscription: an exited session completed it
    // synchronously above, so storing it would strand a closed subscription
    // the delete already ran for.
    if (!subscription.closed) {
      this.fanouts.set(terminalId, subscription);
    }
  }
}
