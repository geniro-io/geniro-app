import { Injectable, type NestMiddleware } from '@nestjs/common';
import { type FastifyReply, type FastifyRequest } from 'fastify';

import { RequestMetric, RequestTimeMetric } from './metrics.types';
import { MetricsService } from './services/metrics.service';

@Injectable()
export class FastifyMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metricsService: MetricsService) {}

  checkIfPathIgnore(path?: string) {
    const ignoredPaths = ['^/health/check.*', '^/swagger-api.*', '^/metrics.*'];

    if (!path) {
      return true;
    }

    for (const pattern of ignoredPaths) {
      if (new RegExp(pattern).test(path)) {
        return true;
      }
    }

    return false;
  }

  use(req: FastifyRequest, res: FastifyReply, next: () => void) {
    const now = Date.now();
    const { originalUrl, method } = req;
    const { statusCode } = res;

    if (this.checkIfPathIgnore(originalUrl)) {
      return next();
    }

    // Label with the ROUTE TEMPLATE (e.g. `/v1/chats/:runId/items`), never the
    // concrete URL: query strings and path parameters carry caller-supplied
    // values (cwd folder paths, run ids, user-named slugs) that must not be
    // republished on the metrics surface, and per-unique-URL labels grow the
    // registry unboundedly. Fastify has routed by the time middleware runs;
    // the query-stripped path remains only as the unrouted (404) fallback.
    const route = (req as { routeOptions?: { url?: string } }).routeOptions
      ?.url;
    const path = route ?? (originalUrl || '').split('?')[0] ?? '';

    this.metricsService.incGauge(RequestMetric, 1, {
      path,
      method,
      status: String(statusCode),
    });

    // @ts-ignore
    res.on('finish', () => {
      this.metricsService.observeHistogram(
        RequestTimeMetric,
        (Date.now() - now) / 1000,
        {
          path,
          method,
        },
      );
    });

    next();
  }
}
