import { UnauthorizedException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ZitadelProvider } from './zitadel.provider';

const ZITADEL_URL = 'http://localhost:8085';
const ZITADEL_ISSUER = 'http://localhost:8085';

const mockJwtVerify = vi.fn();
const mockCreateRemoteJWKSet = vi.fn();

vi.mock('jose', () => ({
  createRemoteJWKSet: (...args: unknown[]) => mockCreateRemoteJWKSet(...args),
  jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
}));

describe('ZitadelProvider', () => {
  let provider: ZitadelProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateRemoteJWKSet.mockReturnValue('mock-keyset');
    provider = new ZitadelProvider({
      url: ZITADEL_URL,
      issuer: ZITADEL_ISSUER,
    });
  });

  it('should configure JWKS URI correctly from provided URL', () => {
    expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
      new URL(`${ZITADEL_URL}/oauth/v2/keys`),
    );
  });

  it('should return sub from valid JWT payload', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { sub: 'user-123', iss: ZITADEL_ISSUER },
    });

    const result = await provider.verifyToken('valid-token');

    expect(result).toEqual({ sub: 'user-123' });
    expect(mockJwtVerify).toHaveBeenCalledWith(
      'valid-token',
      'mock-keyset',
      expect.objectContaining({
        issuer: ZITADEL_ISSUER,
        algorithms: ['RS256'],
      }),
    );
  });

  it('should extract roles from Zitadel project roles claim', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: {
        sub: 'user-123',
        iss: ZITADEL_ISSUER,
        'urn:zitadel:iam:org:project:roles': {
          admin: { orgId: '1' },
          user: { orgId: '1' },
        },
      },
    });

    const result = await provider.verifyToken('valid-token');

    expect(result).toEqual({
      sub: 'user-123',
      roles: ['admin', 'user'],
    });
  });

  it('should omit roles when project roles claim is absent', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { sub: 'user-123', iss: ZITADEL_ISSUER },
    });

    const result = await provider.verifyToken('valid-token');

    expect(result).not.toHaveProperty('roles');
  });

  it('should throw UnauthorizedException when issuer does not match', async () => {
    mockJwtVerify.mockRejectedValue(new Error('unexpected "iss" claim value'));

    await expect(provider.verifyToken('wrong-issuer-token')).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(
      provider.verifyToken('wrong-issuer-token'),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('should throw UnauthorizedException when token is expired', async () => {
    mockJwtVerify.mockRejectedValue(
      new Error('"exp" claim timestamp check failed'),
    );

    await expect(provider.verifyToken('expired-token')).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(provider.verifyToken('expired-token')).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('should throw UnauthorizedException when token is malformed', async () => {
    mockJwtVerify.mockRejectedValue(new Error('Invalid Compact JWS'));

    await expect(provider.verifyToken('not-a-jwt')).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(provider.verifyToken('not-a-jwt')).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('should throw UnauthorizedException when sub claim is missing', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { iss: ZITADEL_ISSUER },
    });

    await expect(provider.verifyToken('no-sub-token')).rejects.toThrow(
      UnauthorizedException,
    );

    try {
      await provider.verifyToken('no-sub-token');
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).statusCode).toBe(401);
      expect((err as UnauthorizedException).code).toBe('UNAUTHORIZED');
    }
  });
});
