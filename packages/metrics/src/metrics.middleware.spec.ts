import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { FastifyMetricsMiddleware } from './metrics.middleware';
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

function fakeReply(): FastifyReply & { emitFinish: () => void } {
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
  } as unknown as FastifyReply & { emitFinish: () => void };
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

  it('labels with the query-stripped path — caller-supplied query values never reach the metrics surface', () => {
    // /metrics is public and CORS-open by design; a query string like
    // ?cwd=/Users/name/project must not be republished as a label there.
    const { middleware, incGauge, observeHistogram } = build();
    const req = {
      originalUrl: '/v1/agents/skills?cwd=/Users/someone/secret-project',
      method: 'GET',
    } as unknown as FastifyRequest;
    const reply = fakeReply();
    const next = vi.fn();

    middleware.use(req, reply, next);
    reply.emitFinish();

    expect(next).toHaveBeenCalledOnce();
    expect(incGauge).toHaveBeenCalledWith(expect.anything(), 1, {
      path: '/v1/agents/skills',
      method: 'GET',
      status: '200',
    });
    expect(observeHistogram).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      { path: '/v1/agents/skills', method: 'GET' },
    );
  });

  it('a query-less path is labeled unchanged', () => {
    const { middleware, incGauge } = build();
    const req = {
      originalUrl: '/v1/workflows',
      method: 'POST',
    } as unknown as FastifyRequest;

    middleware.use(req, fakeReply(), vi.fn());

    expect(incGauge).toHaveBeenCalledWith(expect.anything(), 1, {
      path: '/v1/workflows',
      method: 'POST',
      status: '200',
    });
  });

  it('labels with the route TEMPLATE, never the concrete path parameters', () => {
    // Run UUIDs and user-named slugs are caller-supplied values: labeling the
    // concrete URL republishes them on the public /metrics surface and mints
    // a fresh label per run for the daemon's lifetime.
    const { middleware, incGauge } = build();
    const req = {
      originalUrl: '/v1/chats/0f8b3c1d-run-uuid/items?afterSeq=41',
      method: 'GET',
      routeOptions: { url: '/v1/chats/:runId/items' },
    } as unknown as FastifyRequest;

    middleware.use(req, fakeReply(), vi.fn());

    expect(incGauge).toHaveBeenCalledWith(expect.anything(), 1, {
      path: '/v1/chats/:runId/items',
      method: 'GET',
      status: '200',
    });
  });
});
