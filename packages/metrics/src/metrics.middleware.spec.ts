import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  FastifyMetricsMiddleware,
  ROUTE_TEMPLATE_KEY,
  UNROUTED_LABEL,
} from './metrics.middleware';
import type { MetricsService } from './services/metrics.service';

function build(): {
  middleware: FastifyMetricsMiddleware;
  incGauge: ReturnType<typeof vi.fn>;
  observeHistogram: ReturnType<typeof vi.fn>;
} {
  const incGauge = vi.fn();
  const observeHistogram = vi.fn();
  const middleware = new FastifyMetricsMiddleware({
    incGauge,
    observeHistogram,
  } as unknown as MetricsService);
  return { middleware, incGauge, observeHistogram };
}

/**
 * The raw-request shape Nest's middie shim actually hands the middleware: a
 * bare IncomingMessage-like object — after the module's onRequest hook ran,
 * it carries the route template as a plain own property (never a Fastify
 * `routeOptions` getter, which the raw object does not have).
 */
function rawReq(originalUrl: string, routeTemplate?: string): FastifyRequest {
  return {
    originalUrl,
    method: 'GET',
    ...(routeTemplate !== undefined
      ? { [ROUTE_TEMPLATE_KEY]: routeTemplate }
      : {}),
  } as unknown as FastifyRequest;
}

function fakeReply(): FastifyReply & {
  statusCode: number;
  emitFinish: () => void;
} {
  const listeners: (() => void)[] = [];
  return {
    statusCode: 200,
    on: (_event: string, cb: () => void) => {
      listeners.push(cb);
    },
    emitFinish: () => {
      for (const cb of listeners) {
        cb();
      }
    },
  } as unknown as FastifyReply & { statusCode: number; emitFinish: () => void };
}

describe('FastifyMetricsMiddleware', () => {
  it('ignores the metrics/health/swagger surfaces themselves', () => {
    const { middleware } = build();
    expect(middleware.checkIfPathIgnore('/metrics')).toBe(true);
    expect(middleware.checkIfPathIgnore('/health/check')).toBe(true);
    expect(middleware.checkIfPathIgnore('/swagger-api/reference')).toBe(true);
    expect(middleware.checkIfPathIgnore('/v1/chats')).toBe(false);
    expect(middleware.checkIfPathIgnore(undefined)).toBe(true);
  });

  it('labels with the stamped route TEMPLATE — caller-supplied path/query values never become labels', () => {
    // Run UUIDs, user-named slugs, and cwd query strings are caller-supplied:
    // labeling the concrete URL would republish them on the public /metrics
    // surface and mint a fresh label per run for the daemon's lifetime.
    const { middleware, incGauge, observeHistogram } = build();
    const reply = fakeReply();
    const next = vi.fn();

    middleware.use(
      rawReq(
        '/v1/chats/0f8b3c1d-run-uuid/items?afterSeq=41',
        '/v1/chats/:runId/items',
      ),
      reply,
      next,
    );
    // Control must pass through synchronously — dropping next() hangs every
    // daemon HTTP request while leaving the label assertions green.
    expect(next).toHaveBeenCalledOnce();
    expect(incGauge).not.toHaveBeenCalled();
    reply.emitFinish();

    expect(incGauge).toHaveBeenCalledWith(expect.anything(), 1, {
      path: '/v1/chats/:runId/items',
      method: 'GET',
      status: '200',
    });
    expect(observeHistogram).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      { path: '/v1/chats/:runId/items', method: 'GET' },
    );
  });

  it('an unstamped (unrouted) request labels with the constant, never the concrete path', () => {
    // 404 spray / probes must not mint labels either.
    const { middleware, incGauge } = build();
    const reply = fakeReply();

    middleware.use(rawReq('/wp-admin/setup.php?probe=1'), reply, vi.fn());
    reply.statusCode = 404;
    reply.emitFinish();

    expect(incGauge).toHaveBeenCalledWith(expect.anything(), 1, {
      path: UNROUTED_LABEL,
      method: 'GET',
      status: '404',
    });
  });

  it('reads the status at finish time — not the always-200 of request entry', () => {
    const { middleware, incGauge } = build();
    const reply = fakeReply();

    middleware.use(rawReq('/v1/workflows', '/v1/workflows'), reply, vi.fn());
    reply.statusCode = 503;
    reply.emitFinish();

    expect(incGauge).toHaveBeenCalledWith(expect.anything(), 1, {
      path: '/v1/workflows',
      method: 'GET',
      status: '503',
    });
  });

  it("a reply missing statusCode at finish labels status '0' instead of crashing", () => {
    const { middleware, incGauge } = build();
    const reply = fakeReply();
    delete (reply as unknown as Record<string, unknown>).statusCode;

    middleware.use(rawReq('/v1/workflows', '/v1/workflows'), reply, vi.fn());
    reply.emitFinish();

    expect(incGauge).toHaveBeenCalledWith(expect.anything(), 1, {
      path: '/v1/workflows',
      method: 'GET',
      status: '0',
    });
  });
});
