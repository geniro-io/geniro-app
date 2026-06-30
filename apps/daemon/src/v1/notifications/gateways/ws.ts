import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import type { RuntimeInfo } from '../../../auth/runtime';
import { safeEqual } from '../../../auth/safe-equal';
import { DAEMON_HOST } from '../../../utils/handshake';

/**
 * Register the loopback WS endpoint on the underlying Fastify instance.
 * Browsers can't set an Authorization header on a WS handshake, so the renderer
 * passes the loopback token as a query param. M1 only proves the
 * renderer ⇄ daemon channel (hello + echo); real event streams arrive in M2,
 * when this gateway is wrapped in a NotificationsModule.
 */
export async function registerWebsocket(
  fastify: FastifyInstance,
  runtime: RuntimeInfo,
): Promise<void> {
  await fastify.register(websocket);
  fastify.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
    const url = new URL(request.url, `http://${DAEMON_HOST}`);
    if (!safeEqual(url.searchParams.get('token') ?? '', runtime.token)) {
      socket.close(1008, 'unauthorized');
      return;
    }
    socket.send(JSON.stringify({ type: 'hello', version: runtime.version }));
    socket.on('message', (raw: Buffer) => {
      socket.send(JSON.stringify({ type: 'echo', data: raw.toString() }));
    });
    socket.on('error', (err: Error) =>
      console.error('ws error', { err: String(err) }),
    );
  });
}
