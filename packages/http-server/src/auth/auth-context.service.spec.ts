import { UnauthorizedException } from '@packages/common';
import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import type { IContextData } from './auth.types';
import { AuthContextService } from './auth-context.service';
import { AuthProvider } from './providers/auth.provider';

class MockAuthProvider extends AuthProvider {
  constructor(
    private readonly opts: {
      token?: string;
      verifyResult?: IContextData;
    } = {},
  ) {
    super();
  }

  public getToken?(req: FastifyRequest): string | undefined {
    // return preset token if provided, else fall back to Authorization header
    if (this.opts.token) {
      return this.opts.token;
    }
    const auth = req?.headers?.authorization as string | undefined;
    return auth?.split(' ').pop();
  }

  public async verifyToken(token: string): Promise<IContextData> {
    return this.opts.verifyResult ?? { sub: token };
  }
}

class MockAuthContextDataBuilder {
  constructor(
    private readonly opts: {
      devMode?: boolean;
      devUserResult?: IContextData;
      buildResult?: IContextData;
    } = {},
  ) {}

  public getDevUser(_headers: unknown): IContextData | undefined {
    return this.opts.devUserResult;
  }

  public async buildContextData(
    _token: string,
    _headers: unknown,
  ): Promise<IContextData | undefined> {
    if (this.opts.devMode && this.opts.devUserResult) {
      return this.opts.devUserResult;
    }
    return this.opts.buildResult;
  }
}

describe('AuthContextService', () => {
  let req: FastifyRequest;
  let mockBuilder: MockAuthContextDataBuilder;

  beforeEach(() => {
    req = {
      headers: {},
    } as unknown as FastifyRequest;
    mockBuilder = new MockAuthContextDataBuilder();
  });

  describe('getToken', () => {
    it('uses authProvider.getToken when provided', () => {
      const provider = new MockAuthProvider({ token: 'prov-token' });
      const service = new AuthContextService(
        mockBuilder,
        req,
        undefined,
        provider,
      );

      expect(service.getToken()).toBe('prov-token');
    });

    it('falls back to Authorization header when provider.getToken is not used', () => {
      const service = new AuthContextService(
        mockBuilder,
        {
          headers: { authorization: 'Bearer abc.def' },
        } as unknown as FastifyRequest,
        undefined,
        undefined,
      );

      expect(service.getToken()).toBe('abc.def');
    });

    it('returns undefined when no token present', () => {
      const service = new AuthContextService(
        mockBuilder,
        req,
        undefined,
        undefined,
      );
      expect(service.getToken()).toBeUndefined();
    });
  });

  describe('init', () => {
    it('returns dev user when devMode is true and dev headers present', async () => {
      req.headers = {
        'x-dev-jwt-sub': 'dev-user',
        'authorization': 'Bearer any-token',
      } as any;
      const builder = new MockAuthContextDataBuilder({
        devMode: true,
        devUserResult: { sub: 'dev-user' },
      });
      const service = new AuthContextService(
        builder,
        req,
        undefined,
        undefined,
      );

      await expect(service.init()).resolves.toEqual({
        sub: 'dev-user',
      });
    });

    it('uses provider.verifyToken when token present and not in devMode', async () => {
      req.headers = { authorization: 'Bearer token-123' } as any;
      const provider = new MockAuthProvider({
        verifyResult: { sub: 'verified' },
      });
      const builder = new MockAuthContextDataBuilder({
        devMode: false,
        buildResult: { sub: 'verified' },
      });
      const service = new AuthContextService(builder, req, undefined, provider);

      await expect(service.init()).resolves.toEqual({
        sub: 'verified',
      });
    });

    it('returns undefined when no token present', async () => {
      const service = new AuthContextService(
        mockBuilder,
        req,
        undefined,
        undefined,
      );
      await expect(service.init()).resolves.toBeUndefined();
    });
  });

  describe('sub, checkSub, context', () => {
    it('init stores context and getters work', async () => {
      const provider = new MockAuthProvider({
        verifyResult: { sub: 'u-1', name: 'John' },
      });
      req.headers = { authorization: 'Bearer anything' } as any;
      const builder = new MockAuthContextDataBuilder({
        buildResult: { sub: 'u-1', name: 'John' },
      });
      const service = new AuthContextService(builder, req, undefined, provider);

      const ctx = await service.init();
      expect(ctx).toEqual({ sub: 'u-1', name: 'John' });
      expect(service.sub).toBe('u-1');
      expect(service.context()).toEqual({ sub: 'u-1', name: 'John' });
      expect(service.checkSub()).toBe('u-1');
    });

    it('checkSub throws UnauthorizedException when no sub', async () => {
      const provider = new MockAuthProvider({ verifyResult: {} });
      req.headers = { authorization: 'Bearer t' } as any;
      const builder = new MockAuthContextDataBuilder({
        buildResult: {},
      });
      const service = new AuthContextService(builder, req, undefined, provider);
      await service.init();

      expect(() => service.checkSub()).toThrowError(UnauthorizedException);
      try {
        service.checkSub();
      } catch (e: any) {
        expect(e?.statusCode).toBe(401);
        expect(e?.code).toBe('UNAUTHORIZED');
      }
    });
  });
});
