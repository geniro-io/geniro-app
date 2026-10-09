import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { RequestContextService } from './request-context.service';

describe('RequestContextService.getRequestData', () => {
  it('reports the request URL with its credential masked, as the request log line does', () => {
    // The request-scoped log entry carries the URL as a field beside the line, so
    // the field must hold the same masked URL the line does, not the raw one.
    const request = {
      originalUrl: '/v1/artifacts/run-1/plan?key=k3Yw9&v=2',
      ip: '127.0.0.1',
      method: 'GET',
      body: undefined,
    } as unknown as FastifyRequest & FastifyRequest['raw'];

    const data = new RequestContextService(request).getRequestData();

    expect(data.url).toBe('/v1/artifacts/run-1/plan?key=[REDACTED]&v=2');
  });
});
