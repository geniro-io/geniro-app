import type { Socket } from 'socket.io';

import type { RuntimeInfo } from './runtime';
import { safeEqual } from './safe-equal';

/**
 * The one WS handshake gate, shared by every Socket.IO gateway (engine.io
 * bypasses Nest guards, so each gateway must enforce auth itself — extracted
 * here so a hardening fix can't silently miss a mirrored copy). Browsers can't
 * set headers on a WS upgrade, so the per-launch token rides the handshake
 * `auth` payload; the compare is constant-time. Returns false after
 * disconnecting an unauthenticated socket.
 */
export function enforceWsHandshakeAuth(
  client: Socket,
  runtime: RuntimeInfo,
): boolean {
  const auth = client.handshake.auth as { token?: unknown };
  const token = typeof auth.token === 'string' ? auth.token : '';
  if (!safeEqual(token, runtime.token)) {
    client.disconnect(true);
    return false;
  }
  return true;
}
