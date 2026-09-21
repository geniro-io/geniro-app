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
 *
 * Also accepted from the handshake QUERY, `auth` taking precedence when both
 * carry a usable string: the LAN gateway (Electron main) reverse-proxies `/ws`
 * and swaps its own client-facing token for this one server-side, which it can
 * do to an upgrade URL but not to a Socket.IO `auth` payload buried inside the
 * engine.io CONNECT frame. `handshake.query` is a `ParsedUrlQuery`, so a
 * repeated `token` param reads as an array — that is not a shape this app's
 * clients ever produce, so it is refused rather than guessed at.
 */
export function enforceWsHandshakeAuth(
  client: Socket,
  runtime: RuntimeInfo,
): boolean {
  const auth = client.handshake.auth as { token?: unknown };
  const authToken = typeof auth.token === 'string' ? auth.token : '';
  const queryToken =
    typeof client.handshake.query?.token === 'string'
      ? client.handshake.query.token
      : '';
  const token = authToken !== '' ? authToken : queryToken;
  if (!safeEqual(token, runtime.token)) {
    client.disconnect(true);
    return false;
  }
  return true;
}
