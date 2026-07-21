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

    // Label with the query-stripped path only: query strings carry
    // caller-supplied values (cwd folder paths, cursors) that must not be
    // republished on the metrics surface, and per-unique-URL labels grow the
    // registry unboundedly.
    const path = (originalUrl || '').split('?')[0] ?? '';

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
