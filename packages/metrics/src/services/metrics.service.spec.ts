import { beforeAll, describe, expect, it } from 'vitest';

import { MetricsService } from './metrics.service';

/**
 * One shared service: prom-client registers metric NAMES globally, so a fresh
 * service per test would collide on re-registration. Each test is still
 * self-contained in what it asserts — every mutation is observed through the
 * exposition text getAll() returns, never assumed.
 */
describe(MetricsService, () => {
  const service = new MetricsService();

  describe('gauge metrics', () => {
    beforeAll(() => {
      service.clearAll();
      service.registerGauge('requests', 'all requests', ['path']);
    });

    it('setGauge writes the labeled series', async () => {
      service.setGauge('requests', 10, { path: '/foo/bar' });
      expect(await service.getAll()).toContain('requests{path="/foo/bar"} 10');
    });

    it("throws on a label the metric wasn't registered with", () => {
      expect(() =>
        service.setGauge('requests', 10, { incorrect: 'incorrect' }),
      ).toThrow();
    });

    it('an unregistered index is a silent no-op — no series is minted', async () => {
      service.setGauge('unregistered_gauge', 2);
      expect(await service.getAll()).not.toContain('unregistered_gauge');
    });

    it('incGauge adds to the current value', async () => {
      service.setGauge('requests', 10, { path: '/inc' });
      service.incGauge('requests', 3, { path: '/inc' });
      expect(await service.getAll()).toContain('requests{path="/inc"} 13');
    });

    it('incGauge throws on an unknown label and no-ops on an unknown index', async () => {
      expect(() =>
        service.incGauge('requests', 2, { incorrect: 'incorrect' }),
      ).toThrow();
      service.incGauge('unregistered_gauge', 2);
      expect(await service.getAll()).not.toContain('unregistered_gauge');
    });

    it('reads are idempotent — two exports render the same series', async () => {
      service.setGauge('requests', 7, { path: '/stable' });
      const first = await service.getAll();
      expect(first).toContain('requests{path="/stable"} 7');
      expect(await service.getAll()).toBe(first);
    });

    it('clearAll removes every series from the exposition', async () => {
      await service.clearAll();
      expect(await service.getAll()).not.toContain('requests{');
    });
  });

  describe('counter metrics', () => {
    beforeAll(() => {
      service.clearAll();
      service.registerCounter('requests_counter', 'all requests', ['path']);
    });

    it('incCounter accumulates across calls', async () => {
      service.incCounter('requests_counter', 10, { path: '/foo/bar' });
      service.incCounter('requests_counter', 3, { path: '/foo/bar' });
      expect(await service.getAll()).toContain(
        'requests_counter{path="/foo/bar"} 13',
      );
    });

    it("throws on a label the metric wasn't registered with", () => {
      expect(() =>
        service.incCounter('requests_counter', 10, { incorrect: 'incorrect' }),
      ).toThrow();
    });

    it('an unregistered index is a silent no-op — no series is minted', async () => {
      service.incCounter('unregistered_counter', 2);
      expect(await service.getAll()).not.toContain('unregistered_counter');
    });

    it('clearAll removes every series from the exposition', async () => {
      await service.clearAll();
      expect(await service.getAll()).not.toContain('requests_counter{');
    });
  });

  describe('histogram metrics', () => {
    beforeAll(() => {
      service.clearAll();
      service.registerHistogram('requests_time', 'all requests time', [
        'path',
      ]);
    });

    it('observeHistogram buckets the observation', async () => {
      service.observeHistogram('requests_time', 1.5, { path: '/foo/bar' });
      expect(await service.getAll()).toContain(
        'requests_time_bucket{le="2.5",path="/foo/bar"} 1',
      );
    });

    it("throws on a label the metric wasn't registered with", () => {
      expect(() =>
        service.observeHistogram('requests_time', 10, {
          incorrect: 'incorrect',
        }),
      ).toThrow();
    });

    it('an unregistered index is a silent no-op — no series is minted', async () => {
      service.observeHistogram('unregistered_histogram', 2);
      expect(await service.getAll()).not.toContain('unregistered_histogram');
    });

    it('clearAll removes every series from the exposition', async () => {
      await service.clearAll();
      expect(await service.getAll()).not.toContain('requests_time_bucket{');
    });
  });
});
