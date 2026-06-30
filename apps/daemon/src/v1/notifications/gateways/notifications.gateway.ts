import { Inject } from '@nestjs/common';
import {
  MessageBody,
  type OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  type WsResponse,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';

import { RUNTIME_TOKEN, type RuntimeInfo } from '../../../auth/runtime';
import { safeEqual } from '../../../auth/safe-equal';

/**
 * Loopback notifications gateway (Socket.IO), mirroring Geniro's apps/api
 * SocketGateway. The renderer authenticates with the per-launch loopback token
 * via the Socket.IO handshake `auth` payload (browsers can't set an
 * Authorization header on the WS upgrade; Socket.IO sends `auth` on connect
 * instead). `cors.origin: '*'` is safe here — the daemon binds 127.0.0.1 only
 * and the token is the real gate.
 *
 * M1 only proves the renderer ⇄ daemon channel (a `hello` on connect + `echo`);
 * real event streams (rooms + emitters) arrive in M2 as this gateway grows.
 */
@WebSocketGateway({ path: '/ws', cors: { origin: '*' } })
export class NotificationsGateway implements OnGatewayConnection {
  constructor(@Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo) {}

  handleConnection(client: Socket): void {
    const auth = client.handshake.auth as { token?: unknown };
    const token = typeof auth.token === 'string' ? auth.token : '';
    if (!safeEqual(token, this.runtime.token)) {
      client.disconnect(true);
      return;
    }
    client.emit('hello', { version: this.runtime.version });
  }

  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown): WsResponse<unknown> {
    return { event: 'echo', data };
  }
}
