import type { HttpAdapterHost } from '@nestjs/core';
import type { AppBootstrapperConfigService } from '@packages/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ROUTE_TEMPLATE_KEY } from './metrics.middleware';
import { MetricsModule } from './metrics.module';
import type { MetricsService } from './services/metrics.service';

type OnRequestHook = (
  request: { routeOptions?: { url?: string }; raw: Record<string, unknown> },
  reply: unknown,
  done: () => void,
) => void;

function build(instance: unknown): {
  module: MetricsModule;
  hooks: { name: string; hook: OnRequestHook }[];
} {
  const hooks: { name: string; hook: OnRequestHook }[] = [];
  if (instance && typeof instance === 'object' && 'wantsHooks' in instance) {
    (instance as Record<string, unknown>).addHook = (
      name: string,
      hook: OnRequestHook,
    ) => {
      hooks.push({ name, hook });
    };
  }
  const metricsService = {
    registerGauge: vi.fn(),
    registerHistogram: vi.fn(),
    incGauge: vi.fn(),
  } as unknown as MetricsService;
  const config = {
    appVersion: '0.0.0-test',
    appName: 'test',
  } as unknown as AppBootstrapperConfigService;
  const adapterHost = {
    httpAdapter: { getInstance: () => instance },
  } as unknown as HttpAdapterHost;
  return {
    module: new MetricsModule(metricsService, config, adapterHost),
    hooks,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MetricsModule route-template stamp hook', () => {
  it('stamps the matched route template onto the RAW request', () => {
    vi.useFakeTimers(); // onModuleInit arms the instance-metric interval
    const { module, hooks } = build({ wantsHooks: true });
    module.onModuleInit();

    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.name).toBe('onRequest');
    const raw: Record<string, unknown> = {};
    const done = vi.fn();
    hooks[0]!.hook(
      { routeOptions: { url: '/v1/chats/:runId/items' }, raw },
      null,
      done,
    );

    expect(raw[ROUTE_TEMPLATE_KEY]).toBe('/v1/chats/:runId/items');
    expect(done).toHaveBeenCalledOnce();
  });

  it('leaves an unrouted request unstamped (the middleware then labels it as unrouted)', () => {
    vi.useFakeTimers();
    const { module, hooks } = build({ wantsHooks: true });
    module.onModuleInit();

    const raw: Record<string, unknown> = {};
    hooks[0]!.hook({ raw }, null, vi.fn());

    expect(ROUTE_TEMPLATE_KEY in raw).toBe(false);
  });

  it('degrades to a no-op on an adapter without addHook (never crashes init)', () => {
    vi.useFakeTimers();
    const { module } = build({});

    expect(() => module.onModuleInit()).not.toThrow();
  });
});
