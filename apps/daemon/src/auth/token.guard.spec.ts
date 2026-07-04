import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { LoopbackTokenGuard } from './token.guard';

const TOKEN = 'per-launch-token';

function guard(): LoopbackTokenGuard {
  return new LoopbackTokenGuard({
    token: TOKEN,
    version: '0.0.0-test',
    startedAt: Date.now(),
  });
}

function httpContext(url: string, authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ url, headers: { authorization } }),
    }),
  } as unknown as ExecutionContext;
}

describe('LoopbackTokenGuard', () => {
  describe('public allowlist (segment-boundary match)', () => {
    it.each(['/health', '/health/check', '/metrics', '/swagger-api/reference'])(
      'lets %s through without a token',
      (url) => {
        expect(guard().canActivate(httpContext(url))).toBe(true);
      },
    );

    it('ignores the query string when matching the allowlist', () => {
      expect(guard().canActivate(httpContext('/health/check?verbose=1'))).toBe(
        true,
      );
    });

    it.each(['/health-debug', '/metricsdump', '/swagger-apix/spec'])(
      'does NOT let the sibling route %s inherit the allowlist',
      (url) => {
        expect(guard().canActivate(httpContext(url))).toBe(false);
      },
    );
  });

  describe('bearer token gate', () => {
    it('accepts the exact per-launch bearer token', () => {
      expect(
        guard().canActivate(httpContext('/v1/chats', `Bearer ${TOKEN}`)),
      ).toBe(true);
    });

    it('rejects a missing authorization header', () => {
      expect(guard().canActivate(httpContext('/v1/chats'))).toBe(false);
    });

    it('rejects a wrong token', () => {
      expect(
        guard().canActivate(httpContext('/v1/chats', 'Bearer wrong-token')),
      ).toBe(false);
    });

    it('rejects a bare token without the Bearer scheme', () => {
      expect(guard().canActivate(httpContext('/v1/chats', TOKEN))).toBe(false);
    });

    it('rejects a lowercase scheme (exact prefix, no normalization)', () => {
      expect(
        guard().canActivate(httpContext('/v1/chats', `bearer ${TOKEN}`)),
      ).toBe(false);
    });

    it('gates a public-looking path that only shares a prefix', () => {
      expect(
        guard().canActivate(httpContext('/healthz', `Bearer ${TOKEN}`)),
      ).toBe(true);
      expect(guard().canActivate(httpContext('/healthz'))).toBe(false);
    });
  });
});
