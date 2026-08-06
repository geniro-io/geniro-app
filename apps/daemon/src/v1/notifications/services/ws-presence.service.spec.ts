import { describe, expect, it } from 'vitest';

import { WsPresenceService } from './ws-presence.service';

describe('WsPresenceService', () => {
  it('starts with nobody connected', () => {
    expect(new WsPresenceService().connected).toBe(0);
  });

  it('counts admitted clients and forgets them on disconnect', () => {
    const presence = new WsPresenceService();

    presence.opened('a');
    presence.opened('b');
    expect(presence.connected).toBe(2);

    presence.closed('a');
    expect(presence.connected).toBe(1);
  });

  it('does not go negative when a REJECTED socket disconnects', () => {
    // The gateway returns early for a failed handshake, but Socket.IO still
    // fires handleDisconnect for that socket. With a counter this reaches -1
    // and the daemon then believes it has clients forever, silently disabling
    // the idle shutdown.
    const presence = new WsPresenceService();

    presence.closed('never-admitted');

    expect(presence.connected).toBe(0);
  });

  it('is idempotent per socket id', () => {
    const presence = new WsPresenceService();

    presence.opened('a');
    presence.opened('a');
    presence.closed('a');

    expect(presence.connected).toBe(0);
  });
});
