import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { CallTokenRegistry } from './call-token.registry';
import { LoopbackTokenGuard } from './token.guard';

const TOKEN = 'per-launch-token';

function guard(callTokens = new CallTokenRegistry()): LoopbackTokenGuard {
  return new LoopbackTokenGuard(
    {
      token: TOKEN,
      version: '0.0.0-test',
      startedAt: Date.now(),
    },
    callTokens,
  );
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
    it.each(['/health', '/health/check'])(
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

    it.each(['/metrics', '/swagger-api/reference'])(
      'gates %s behind the token — any web page could otherwise read it cross-origin',
      (url) => {
        expect(guard().canActivate(httpContext(url))).toBe(false);
        expect(guard().canActivate(httpContext(url, `Bearer ${TOKEN}`))).toBe(
          true,
        );
      },
    );

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

  describe('per-node call token (MCP namespace)', () => {
    const CALL = 'orch-call-token';

    function registryWith(
      runId: string,
      nodeId: string,
      token: string,
    ): CallTokenRegistry {
      const registry = new CallTokenRegistry();
      registry.issue(runId, nodeId, token);
      return registry;
    }

    it("opens exactly the issuing node's MCP route", () => {
      const g = guard(registryWith('run-1', 'orch', CALL));
      expect(
        g.canActivate(httpContext('/v1/mcp/run-1/orch', `Bearer ${CALL}`)),
      ).toBe(true);
    });

    it("rejects the token on ANOTHER node's route in the same run (no nodeId spoof)", () => {
      const g = guard(registryWith('run-1', 'orch', CALL));
      expect(
        g.canActivate(httpContext('/v1/mcp/run-1/helper', `Bearer ${CALL}`)),
      ).toBe(false);
    });

    it("rejects the call token on another run's MCP route", () => {
      const g = guard(registryWith('run-1', 'orch', CALL));
      expect(
        g.canActivate(httpContext('/v1/mcp/run-2/orch', `Bearer ${CALL}`)),
      ).toBe(false);
    });

    it('rejects the call token everywhere off the MCP namespace', () => {
      const g = guard(registryWith('run-1', 'orch', CALL));
      expect(g.canActivate(httpContext('/v1/chats', `Bearer ${CALL}`))).toBe(
        false,
      );
      // Prefix look-alike must not inherit the call-token acceptance.
      expect(
        g.canActivate(httpContext('/v1/mcpx/run-1/orch', `Bearer ${CALL}`)),
      ).toBe(false);
    });

    it('still accepts the launch token on an MCP route', () => {
      const g = guard(registryWith('run-1', 'orch', CALL));
      expect(
        g.canActivate(httpContext('/v1/mcp/run-1/orch', `Bearer ${TOKEN}`)),
      ).toBe(true);
    });

    it('rejects a revoked call token', () => {
      const registry = registryWith('run-1', 'orch', CALL);
      const g = guard(registry);
      registry.revokeRun('run-1');
      expect(
        g.canActivate(httpContext('/v1/mcp/run-1/orch', `Bearer ${CALL}`)),
      ).toBe(false);
    });

    it('decodes percent-encoded run/node segments before the lookup', () => {
      const g = guard(registryWith('run 1', 'node/x', CALL));
      expect(
        g.canActivate(
          httpContext('/v1/mcp/run%201/node%2Fx', `Bearer ${CALL}`),
        ),
      ).toBe(true);
    });

    it('rejects a missing node segment and malformed encoding without throwing', () => {
      const g = guard(registryWith('run-1', 'orch', CALL));
      // runId present, nodeId missing.
      expect(
        g.canActivate(httpContext('/v1/mcp/run-1', `Bearer ${CALL}`)),
      ).toBe(false);
      expect(g.canActivate(httpContext('/v1/mcp/', `Bearer ${CALL}`))).toBe(
        false,
      );
      expect(
        g.canActivate(httpContext('/v1/mcp/%E0%A4%A/orch', `Bearer ${CALL}`)),
      ).toBe(false);
    });
  });
});
