import { Injectable } from '@nestjs/common';

/**
 * How many clients are attached to the WS channel right now.
 *
 * The renderer is the daemon's only client, so this is the daemon's answer to
 * "is anyone actually using me?" — which is what the idle shutdown decides on.
 *
 * Socket IDS, not a counter, and that is load-bearing: `handleConnection`
 * returns early for a socket that fails the token check, but Socket.IO still
 * fires `handleDisconnect` for it. A counter would go negative on every
 * rejected handshake and the daemon would then believe it had clients forever,
 * silently disabling the shutdown it exists to trigger. A set of the ids we
 * actually admitted cannot drift that way.
 */
@Injectable()
export class WsPresenceService {
  private readonly admitted = new Set<string>();

  /** Record a client that passed the handshake gate. */
  opened(socketId: string): void {
    this.admitted.add(socketId);
  }

  /** Record a client going away. Unknown ids (rejected sockets) are ignored. */
  closed(socketId: string): void {
    this.admitted.delete(socketId);
  }

  /** Clients currently attached. */
  get connected(): number {
    return this.admitted.size;
  }
}
