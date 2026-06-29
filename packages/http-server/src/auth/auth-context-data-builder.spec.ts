import { beforeEach, describe, expect, it } from 'vitest';

import type { IContextData } from './auth.types';
import { AuthContextDataBuilder } from './auth-context-data-builder';
import { AuthProvider } from './providers/auth.provider';

class MockAuthProvider extends AuthProvider {
  constructor(
    private readonly opts: {
      verifyResult?: IContextData;
    } = {},
  ) {
    super();
  }

  public async verifyToken(token: string): Promise<IContextData> {
    return this.opts.verifyResult ?? { sub: token };
  }
}

describe('AuthContextDataBuilder', () => {
  let builder: AuthContextDataBuilder;

  beforeEach(() => {
    builder = new AuthContextDataBuilder();
  });

  it('should be defined', () => {
    expect(builder).toBeDefined();
  });

  describe('getDevUser', () => {
    it('should return undefined when no dev headers are present', () => {
      const headers = {
        'content-type': 'application/json',
        'user-agent': 'test-agent',
      };

      const result = builder.getDevUser(headers);

      expect(result).toBeUndefined();
    });

    it('should extract dev user data from x-dev-jwt- headers', () => {
      const headers = {
        'x-dev-jwt-sub': 'user123',
        'x-dev-jwt-email': 'test@example.com',
        'x-dev-jwt-name': 'Test User',
        'x-dev-jwt-roles': '["admin", "user"]',
        'other-header': 'should-be-ignored',
      };

      const result = builder.getDevUser(headers);

      expect(result).toEqual({
        sub: 'user123',
        email: 'test@example.com',
        name: 'Test User',
        roles: ['admin', 'user'],
      });
    });

    it('should handle JSON parsing for complex values', () => {
      const headers = {
        'x-dev-jwt-sub': 'user123',
        'x-dev-jwt-metadata': '{"key": "value", "nested": {"prop": 123}}',
      };

      const result = builder.getDevUser(headers);

      expect(result).toEqual({
        sub: 'user123',
        metadata: { key: 'value', nested: { prop: 123 } },
      });
    });

    it('should handle invalid JSON gracefully', () => {
      const headers = {
        'x-dev-jwt-sub': 'user123',
        'x-dev-jwt-invalid-json': 'invalid-json-string',
      };

      const result = builder.getDevUser(headers);

      expect(result).toEqual({
        sub: 'user123',
        'invalid-json': 'invalid-json-string',
      });
    });

    it('should return undefined when only non-dev headers are present', () => {
      const headers = {
        'x-custom-header': 'value',
        'authorization': 'Bearer token123',
      };

      const result = builder.getDevUser(headers);

      expect(result).toBeUndefined();
    });
  });

  describe('buildContextData', () => {
    it('should return dev user data when dev mode is enabled and dev headers exist', async () => {
      const headers = {
        'x-dev-jwt-sub': 'dev-user',
        'x-dev-jwt-email': 'dev@example.com',
      };
      const builderWithDevMode = new AuthContextDataBuilder({ devMode: true });

      const result = await builderWithDevMode.buildContextData(
        'token123',
        headers,
      );

      expect(result).toEqual({
        sub: 'dev-user',
        email: 'dev@example.com',
      });
    });

    it('should fallback to token verification when dev mode is enabled but no dev headers', async () => {
      const mockContextData: IContextData = {
        sub: 'token-user',
        email: 'token@example.com',
      };
      const provider = new MockAuthProvider({ verifyResult: mockContextData });
      const builderWithProvider = new AuthContextDataBuilder(
        { devMode: true },
        provider,
      );

      const headers = {
        'authorization': 'Bearer token123',
      };

      const result = await builderWithProvider.buildContextData(
        'token123',
        headers,
      );

      expect(result).toEqual(mockContextData);
    });

    it('should verify token when dev mode is disabled', async () => {
      const mockContextData: IContextData = {
        sub: 'token-user',
        email: 'token@example.com',
      };
      const provider = new MockAuthProvider({ verifyResult: mockContextData });
      const builderWithProvider = new AuthContextDataBuilder(
        { devMode: false },
        provider,
      );

      const headers = {
        'authorization': 'Bearer token123',
      };

      const result = await builderWithProvider.buildContextData(
        'token123',
        headers,
      );

      expect(result).toEqual(mockContextData);
    });

    it('should return undefined when no token and no auth provider', async () => {
      const headers = {};

      const result = await builder.buildContextData('', headers);

      expect(result).toBeUndefined();
    });

    it('should return undefined when no token but auth provider exists', async () => {
      const provider = new MockAuthProvider();
      const builderWithProvider = new AuthContextDataBuilder(
        undefined,
        provider,
      );
      const headers = {};

      const result = await builderWithProvider.buildContextData('', headers);

      expect(result).toBeUndefined();
    });

    it('should handle auth provider verification errors', async () => {
      const provider = new MockAuthProvider();
      // Override verifyToken to throw an error
      provider.verifyToken = async () => {
        throw new Error('Invalid token');
      };
      const builderWithProvider = new AuthContextDataBuilder(
        undefined,
        provider,
      );

      const headers = {
        'authorization': 'Bearer invalid-token',
      };

      await expect(
        builderWithProvider.buildContextData('invalid-token', headers),
      ).rejects.toThrow('Invalid token');
    });
  });
});
