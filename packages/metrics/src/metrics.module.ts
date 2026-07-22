import {
  type DynamicModule,
  Global,
  type MiddlewareConsumer,
  Module,
  type OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { AppBootstrapperConfigService } from '@packages/common';

import { MetricsController } from './metrics.controller';
import {
  FastifyMetricsMiddleware,
  ROUTE_TEMPLATE_KEY,
} from './metrics.middleware';
import {
  InstanceMetric,
  RequestMetric,
  RequestTimeMetric,
} from './metrics.types';
import { MetricsService } from './services/metrics.service';

/**
 * The narrow Fastify surface the route-template stamp needs — duck-typed so a
 * non-Fastify adapter degrades to a no-op (every request then labels as
 * unrouted) instead of crashing module init.
 */
interface FastifyLike {
  addHook?: (
    name: 'onRequest',
    hook: (
      request: { routeOptions?: { url?: string }; raw: unknown },
      reply: unknown,
      done: () => void,
    ) => void,
  ) => void;
}

@Module({})
@Global()
export class MetricsModule implements OnModuleInit {
  public static init?: (svc: MetricsService) => void;

  static forRoot(init?: (svc: MetricsService) => void): DynamicModule {
    MetricsModule.init = init;

    return {
      module: MetricsModule,
      controllers: [MetricsController],
      providers: [MetricsService],
      exports: [MetricsService],
    };
  }

  constructor(
    private metricsService: MetricsService,
    private appBootstrapperConfigService: AppBootstrapperConfigService,
    private adapterHost: HttpAdapterHost,
  ) {}

  onModuleInit() {
    if (MetricsModule.init) {
      MetricsModule.init(this.metricsService);
    }

    // Bridge Fastify's router to the middleware: stamp the matched route
    // template onto the RAW request (routing precedes onRequest hooks, and
    // Nest's middie shim hands middleware only the raw IncomingMessage). The
    // middleware reads the stamp at response `finish`, so hook-vs-middleware
    // ordering is irrelevant. Unrouted requests leave no stamp.
    const fastify = this.adapterHost?.httpAdapter?.getInstance?.() as
      FastifyLike | undefined;
    fastify?.addHook?.('onRequest', (request, _reply, done) => {
      const url = request.routeOptions?.url;
      if (typeof url === 'string') {
        (request.raw as Record<string, unknown>)[ROUTE_TEMPLATE_KEY] = url;
      }
      done();
    });

    this.metricsService.registerGauge(
      RequestMetric,
      'counter for incoming requests',
      ['path', 'method', 'status'],
    );

    this.metricsService.registerHistogram(
      RequestTimeMetric,
      'incoming requests time',
      ['path', 'method'],
      //  [0.1, 0.5, 1, 2, 5, 10, 30],
    );

    this.metricsService.registerGauge(InstanceMetric, 'Application instance', [
      'version',
      'pid',
      'app',
    ]);

    setInterval(() => {
      this.metricsService.incGauge(InstanceMetric, 1, {
        version: this.appBootstrapperConfigService.appVersion,
        pid: String(process.pid),
        app: this.appBootstrapperConfigService.appName,
      });
    }, 60 * 1000);
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(FastifyMetricsMiddleware).forRoutes('*path');
  }
}
