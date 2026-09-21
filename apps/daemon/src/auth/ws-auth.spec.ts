import type { Socket } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeInfo } from './runtime';
import { enforceWsHandshakeAuth } from './ws-auth';

const runtime: RuntimeInfo = {
  token: 'good-token',
  version: '9.9.9',
  startedAt: 0,
  port: 47615,
};

type HandshakeQuery = Record<string, string | string[] | undefined>;

function fakeSocket(
  auth: unknown,
  query: HandshakeQuery = {},
): {
  handshake: { auth: unknown; query: HandshakeQuery };
  disconnect: ReturnType<typeof vi.fn>;
} {
  return {
    handshake: { auth, query },
    disconnect: vi.fn(),
  };
}

describe('enforceWsHandshakeAuth', () => {
  it('authenticates a correct token carried in the auth payload', () => {
    const socket = fakeSocket({ token: 'good-token' });

    expect(enforceWsHandshakeAuth(socket as unknown as Socket, runtime)).toBe(
      true,
    );
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('authenticates a correct token carried in the query', () => {
    const socket = fakeSocket({}, { token: 'good-token' });

    expect(enforceWsHandshakeAuth(socket as unknown as Socket, runtime)).toBe(
      true,
    );
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('refuses a wrong token in the auth payload and disconnects', () => {
    const socket = fakeSocket({ token: 'wrong-token' });

    expect(enforceWsHandshakeAuth(socket as unknown as Socket, runtime)).toBe(
      false,
    );
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('refuses a wrong token in the query and disconnects', () => {
    const socket = fakeSocket({}, { token: 'wrong-token' });

    expect(enforceWsHandshakeAuth(socket as unknown as Socket, runtime)).toBe(
      false,
    );
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('refuses a handshake carrying no token at all', () => {
    const socket = fakeSocket({});

    expect(enforceWsHandshakeAuth(socket as unknown as Socket, runtime)).toBe(
      false,
    );
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('prefers the auth token when both carriers are present and auth is valid', () => {
    const socket = fakeSocket(
      { token: 'good-token' },
      { token: 'wrong-token' },
    );

    expect(enforceWsHandshakeAuth(socket as unknown as Socket, runtime)).toBe(
      true,
    );
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('refuses a query token that arrives as an array rather than coercing it', () => {
    const socket = fakeSocket({}, { token: ['good-token', 'good-token'] });

    expect(enforceWsHandshakeAuth(socket as unknown as Socket, runtime)).toBe(
      false,
    );
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});
