import { Injectable, type NestMiddleware } from '@nestjs/common';
import { type FastifyReply, type FastifyRequest } from 'fastify';

import { RequestMetric, RequestTimeMetric } from './metrics.types';
import { MetricsService } from './services/metrics.service';

/**
 * Own-property key the module's Fastify `onRequest` hook stamps onto the RAW
 * request. Nest's middie shim hands middleware the bare `http.IncomingMessage`
 * (no `routeOptions` getter), so the stamp is the only bridge from Fastify's
 * router to the metrics labels.
 */
export const ROUTE_TEMPLATE_KEY = 'geniroRouteTemplate';

/**
 * Label for requests Fastify never routed (404 spray, probes). A constant —
 * never the concrete path — so unrouted noise cannot mint labels.
 */
export const UNROUTED_LABEL = 'unrouted';

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

    if (this.checkIfPathIgnore(originalUrl)) {
      return next();
    }

    // Label at response `finish`, never at request entry: the route template
    // is stamped by the module's onRequest hook (order-independent — finish
    // fires after every hook), and only at finish is the real status code
    // known. Labeling the ROUTE TEMPLATE (e.g. `/v1/chats/:runId/items`)
    // keeps caller-supplied values (run ids, user-named slugs, cwd query
    // strings) off the public /metrics surface and bounds label cardinality
    // to the route table.
    // @ts-ignore
    res.on('finish', () => {
      const path = (req as unknown as Record<string, unknown>)[
        ROUTE_TEMPLATE_KEY
      ];
      const labels = {
        path: typeof path === 'string' ? path : UNROUTED_LABEL,
        method,
      };
      this.metricsService.incGauge(RequestMetric, 1, {
        ...labels,
        status: String(
          (res as unknown as { statusCode?: number }).statusCode ?? 0,
        ),
      });
      this.metricsService.observeHistogram(
        RequestTimeMetric,
        (Date.now() - now) / 1000,
        labels,
      );
    });

    next();
  }
}
