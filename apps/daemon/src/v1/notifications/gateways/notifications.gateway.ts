import { Inject, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  type WsResponse,
} from '@nestjs/websockets';
import type { Subscription } from 'rxjs';
import type { Server, Socket } from 'socket.io';

import { RUNTIME_TOKEN, type RuntimeInfo } from '../../../auth/runtime';
import { enforceWsHandshakeAuth } from '../../../auth/ws-auth';
import { MAX_ANSWER_LENGTH } from '../../agents/chat.types';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import {
  extractBooleanField,
  extractStringField,
} from '../../agents/utils/ws-payload';
import { DebugLogService } from '../../diagnostics/services/debug-log.service';
import { UsageEventBus } from '../../stats/services/usage-events.bus';
import { WsPresenceService } from '../services/ws-presence.service';

/**
 * Defensively read a `verdict` payload: `{runId, requestId, allow, answer?}`.
 * `answer` is the user's picked option / typed text for a question card
 * (AskUserQuestion, M4) — optional and only honored as a non-empty string, so
 * the plain approve/deny wire stays byte-compatible.
 *
 * TWIN PARSER: the renderer produces this envelope in
 * `DaemonClient.sendVerdict` (apps/ui/src/renderer/daemon-client.ts) — no
 * daemon↔renderer shared package exists, so a shape change here must be
 * mirrored there, and vice versa.
 */
function extractVerdict(data: unknown): {
  runId: string;
  requestId: string;
  allow: boolean;
  answer?: string;
} | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const { runId, requestId, allow, answer } = data as {
    runId?: unknown;
    requestId?: unknown;
    allow?: unknown;
    answer?: unknown;
  };
  if (
    typeof runId !== 'string' ||
    runId.length === 0 ||
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    typeof allow !== 'boolean' ||
    (answer !== undefined &&
      (typeof answer !== 'string' ||
        answer.length === 0 ||
        answer.length > MAX_ANSWER_LENGTH))
  ) {
    return null;
  }
  return {
    runId,
    requestId,
    allow,
    answer: typeof answer === 'string' ? answer : undefined,
  };
}

/** Socket.IO room a client joins to receive one run's streamed items. */
function runRoom(runId: string): string {
  return `run:${runId}`;
}

/**
 * The room a client joins to receive the debug log.
 *
 * Not keyed by anything: the log is daemon-wide, and there is exactly one of
 * it. A room rather than a broadcast because nobody should receive this unless
 * they opened the panel — with `agent-stdio` on it is thousands of lines a
 * turn, and a client that is not showing them would be paying to throw them
 * away.
 */
const DEBUG_ROOM = 'debug';

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
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    OnModuleDestroy
{
  private readonly logger = new Logger(NotificationsGateway.name);
  private busSubscription?: Subscription;
  private deltaSubscription?: Subscription;
  private statusSubscription?: Subscription;
  private debugSubscription?: Subscription;
  private usageSubscription?: Subscription;
  /**
   * Debug fan-out failures, counted rather than logged.
   *
   * Logging one would feed the very stream that just failed — `this.logger`
   * writes into the debug sink — so an emit error would produce an entry,
   * which would fail to emit, which would log again. A counter breaks that
   * loop; the diagnostics report is where it surfaces.
   */
  private debugEmitFailures = 0;

  constructor(
    @Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo,
    private readonly bus: AgentEventBus,
    private readonly approvals: ApprovalRegistry,
    private readonly presence: WsPresenceService,
    private readonly debugLog: DebugLogService,
    private readonly usage: UsageEventBus,
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
    // The EPHEMERAL live-text plane rides the same rooms, as its own event so
    // a client can ignore it entirely and still receive a complete transcript.
    // Isolated for the same reason as above: a throw here must not kill item
    // delivery, which is the durable half.
    this.deltaSubscription = this.bus.allDeltas().subscribe({
      next: (delta) => {
        try {
          server.to(runRoom(delta.runId)).emit('agent_delta', delta);
        } catch (err) {
          this.logger.error(
            `failed to emit agent_delta to ${runRoom(delta.runId)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`agent delta bus errored: ${String(err)}`),
    });
    // Run status goes to EVERY client, not to the run's room. A client only
    // joins the run it is showing, so a background run's badge had no way to
    // learn it had settled and lied until the next refetch. Isolated like the
    // two above.
    this.statusSubscription = this.bus.allStatuses().subscribe({
      next: (status) => {
        try {
          server.emit('run_status', status);
        } catch (err) {
          this.logger.error(
            `failed to broadcast run_status for ${status.runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`run status bus errored: ${String(err)}`),
    });
    // A recorded turn goes to EVERY client, like `run_status` and for the
    // mirror-image reason: the page that cares is Stats, which belongs to no
    // run's room — it is about all of them at once. It is a handful of bytes
    // per finished turn, and without it an open Stats page kept showing the
    // totals it was opened on while the agent went on spending. Isolated like
    // its neighbours, so a throw here cannot take transcript delivery with it.
    this.usageSubscription = this.usage.all().subscribe({
      next: (event) => {
        try {
          server.emit('usage_recorded', event);
        } catch (err) {
          this.logger.error(
            `failed to broadcast usage_recorded for ${event.runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      error: (err: unknown) =>
        this.logger.error(`usage event bus errored: ${String(err)}`),
    });
    // The debug log goes to the DEBUG_ROOM, not to every client — the one
    // stream here that nobody should receive by default. It carries the raw
    // agent conversation when that channel is on, at thousands of lines a
    // turn, and a client that never opened the panel has no use for a single
    // one of them. Joining the room is the act of opening the panel.
    //
    // Isolated like its neighbours: a throw in this fan-out must not be able
    // to kill transcript delivery, which is the half the app depends on.
    this.debugSubscription = this.debugLog.stream().subscribe({
      next: (entry) => {
        try {
          server.to(DEBUG_ROOM).emit('debug', entry);
        } catch {
          // Deliberately NOT `this.logger.error`: that call is itself a source
          // of debug entries, so logging a fan-out failure through it feeds
          // the stream that just failed and recurses. The counter is what
          // records it instead.
          this.debugEmitFailures += 1;
        }
      },
      error: () => {
        this.debugEmitFailures += 1;
      },
    });
  }

  onModuleDestroy(): void {
    this.busSubscription?.unsubscribe();
    this.deltaSubscription?.unsubscribe();
    this.statusSubscription?.unsubscribe();
    this.debugSubscription?.unsubscribe();
    this.usageSubscription?.unsubscribe();
  }

  /**
   * Start/stop receiving debug entries on this socket.
   *
   * A room rather than a per-socket flag so the fan-out stays one `emit` no
   * matter how many clients are watching, exactly like the run rooms.
   */
  @SubscribeMessage('debug_subscribe')
  async debugSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): Promise<WsResponse<{ subscribed: boolean }>> {
    // Default TRUE: `debug_subscribe` with no body plainly means "subscribe",
    // and a missing field must not silently mean the opposite.
    const on = extractBooleanField(data, 'on') ?? true;
    if (on) {
      await client.join(DEBUG_ROOM);
    } else {
      await client.leave(DEBUG_ROOM);
    }
    return { event: 'debug_subscribed', data: { subscribed: on } };
  }

  handleConnection(client: Socket): void {
    if (!enforceWsHandshakeAuth(client, this.runtime)) {
      // Deliberately NOT counted: a socket that failed the token check was
      // never a client, and counting it would keep the daemon believing
      // someone is using it.
      return;
    }
    this.presence.opened(client.id);
    client.emit('hello', { version: this.runtime.version });
  }

  handleDisconnect(client: Socket): void {
    this.presence.closed(client.id);
  }

  @SubscribeMessage('join')
  async join(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): Promise<WsResponse<{ runId: string | null }>> {
    const runId = extractRunId(data);
    if (runId) {
      await client.join(runRoom(runId));
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
   * paused `ask`-node turn via the {@link ApprovalRegistry}. The acknowledgment
   * distinguishes applied, expired, and retryable-invalid payloads. The socket
   * is already token-authenticated at `handleConnection`.
   *
   * TWIN PARSER: the `verdict_ack` reply shape is re-declared by the renderer
   * as `VerdictAck` (apps/ui/src/renderer/daemon-client.ts) — a shape change
   * here must be mirrored there, and vice versa.
   */
  @SubscribeMessage('verdict')
  verdict(@MessageBody() data: unknown): WsResponse<{
    runId: string | null;
    requestId: string | null;
    status: 'applied' | 'expired' | 'invalid';
  }> {
    const parsed = extractVerdict(data);
    if (!parsed) {
      return {
        event: 'verdict_ack',
        data: {
          runId: extractStringField(data, 'runId'),
          requestId: extractStringField(data, 'requestId'),
          status: 'invalid',
        },
      };
    }
    const applied = this.approvals.resolve(
      parsed.runId,
      parsed.requestId,
      parsed.allow,
      parsed.answer,
    );
    return {
      event: 'verdict_ack',
      data: {
        runId: parsed.runId,
        requestId: parsed.requestId,
        status: applied ? 'applied' : 'expired',
      },
    };
  }

  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown): WsResponse<unknown> {
    return { event: 'echo', data };
  }
}
