import { Inject, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  type WsResponse,
} from '@nestjs/websockets';
import type { Subscription } from 'rxjs';
import type { Server, Socket } from 'socket.io';

import { RUNTIME_TOKEN, type RuntimeInfo } from '../../../auth/runtime';
import { enforceWsHandshakeAuth } from '../../../auth/ws-auth';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import { extractStringField } from '../../agents/utils/ws-payload';

/** Defensively read a `verdict` payload: `{runId, requestId, allow}`. */
function extractVerdict(
  data: unknown,
): { runId: string; requestId: string; allow: boolean } | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const { runId, requestId, allow } = data as {
    runId?: unknown;
    requestId?: unknown;
    allow?: unknown;
  };
  if (
    typeof runId !== 'string' ||
    runId.length === 0 ||
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    typeof allow !== 'boolean'
  ) {
    return null;
  }
  return { runId, requestId, allow };
}

/** Socket.IO room a client joins to receive one run's streamed items. */
function runRoom(runId: string): string {
  return `run:${runId}`;
}

/** Defensively read a runId from a `join`/`leave` payload (string or `{runId}`). */
function extractRunId(data: unknown): string | null {
  return extractStringField(data, 'runId');
}

/**
 * Loopback notifications gateway (Socket.IO). The renderer authenticates with
 * the per-launch loopback token via the handshake `auth` payload (browsers
 * can't set an Authorization header on the WS upgrade). `cors.origin: '*'` is
 * safe — the daemon binds 127.0.0.1 only and the token is the real gate.
 *
 * M2 grows the M1 hello/echo stub into the live run-event channel: a single
 * subscription to {@link AgentEventBus} fans each persisted item out to its
 * run's room, and clients `join`/`leave` a run to stream it. Because items are
 * persisted before they reach the bus (persist-then-emit), a client that joins
 * late replays the history over REST first, then attaches here for live items,
 * de-duplicating on `seq`.
 */
@WebSocketGateway({ path: '/ws', cors: { origin: '*' } })
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationsGateway.name);
  private busSubscription?: Subscription;

  constructor(
    @Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo,
    private readonly bus: AgentEventBus,
    private readonly approvals: ApprovalRegistry,
  ) {}

  afterInit(server: Server): void {
    // Isolate per-emit failures: a single throw from `emit` (or a bus error)
    // must not terminate this subscription, or ALL live streaming would die
    // silently for the rest of the daemon's life.
    this.busSubscription = this.bus.all().subscribe({
      next: ({ runId, item }) => {
        try {
          server.to(runRoom(runId)).emit('item', item);
        } catch (err) {
          this.logger.error(
            `failed to emit item to ${runRoom(runId)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`agent event bus errored: ${String(err)}`),
    });
  }

  onModuleDestroy(): void {
    this.busSubscription?.unsubscribe();
  }

  handleConnection(client: Socket): void {
    if (!enforceWsHandshakeAuth(client, this.runtime)) {
      return;
    }
    client.emit('hello', { version: this.runtime.version });
  }

  @SubscribeMessage('join')
  join(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): WsResponse<{ runId: string | null }> {
    const runId = extractRunId(data);
    if (runId) {
      void client.join(runRoom(runId));
    }
    return { event: 'joined', data: { runId } };
  }

  @SubscribeMessage('leave')
  leave(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): WsResponse<{ runId: string | null }> {
    const runId = extractRunId(data);
    if (runId) {
      void client.leave(runRoom(runId));
    }
    return { event: 'left', data: { runId } };
  }

  /**
   * The elicitation card's answer: routes a tool-approval verdict to the
   * paused `ask`-node turn via the {@link ApprovalRegistry}. `applied: false`
   * means the request is unknown or already settled (e.g. the node's turn
   * ended first) — the card renders it as expired. The socket is already
   * token-authenticated at `handleConnection`.
   */
  @SubscribeMessage('verdict')
  verdict(
    @MessageBody() data: unknown,
  ): WsResponse<{ requestId: string | null; applied: boolean }> {
    const parsed = extractVerdict(data);
    if (!parsed) {
      return {
        event: 'verdict_ack',
        data: { requestId: null, applied: false },
      };
    }
    const applied = this.approvals.resolve(
      parsed.runId,
      parsed.requestId,
      parsed.allow,
    );
    return {
      event: 'verdict_ack',
      data: { requestId: parsed.requestId, applied },
    };
  }

  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown): WsResponse<unknown> {
    return { event: 'echo', data };
  }
}
