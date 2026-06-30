import { beforeAll, describe, expect, it, vi } from 'vitest';

import { MetricsService } from './metrics.service';

describe(MetricsService, () => {
  const service = new MetricsService();

  describe('should correctly generate gauge metrics', () => {
    beforeAll(() => {
      vi.clearAllMocks();
      service.clearAll();
      service.registerGauge('requests', 'all requests', ['path']);
    });

    it('should set metrics', () => {
      service.setGauge('requests', 10, { path: '/foo/bar' });
    });

    it("shouldn't set metrics with incorrect label", () => {
      expect(() =>
        service.setGauge('requests', 10, { incorrect: 'incorrect' }),
      ).toThrow();
    });

    it('should set metrics with incorrect index', () => {
      service.setGauge('incorrect', 2);
    });

    it('should add metrics', () => {
      service.incGauge('requests', 3, { path: '/foo/bar' });
    });

    it('should add metrics with incorrect label', () => {
      expect(() =>
        service.incGauge('requests', 2, { incorrect: 'incorrect' }),
      ).toThrow();
    });

    it('should add metrics with incorrect index', () => {
      service.incGauge('incorrect', 2);
    });

    it('should get metrics', async () => {
      const metrics = await service.getAll();

      expect(metrics).toContain('requests{path="/foo/bar"} 13');
    });

    it('should get metrics second time', async () => {
      const metrics = await service.getAll();

      expect(metrics).toContain('requests{path="/foo/bar"} 13');
    });

    it('should clear metrics', async () => {
      await service.clearAll();
      const metrics = await service.getAll();

      expect(metrics).not.toContain('requests{path="/foo/bar"} 13');
    });
  });

  describe('should correctly generate counter metrics', () => {
    beforeAll(() => {
      vi.clearAllMocks();
      service.clearAll();
      service.registerCounter('requests_counter', 'all requests', ['path']);
    });

    it('should set metrics', () => {
      service.incCounter('requests_counter', 10, { path: '/foo/bar' });
    });

    it("shouldn't set metrics with incorrect label", () => {
      expect(() =>
        service.incCounter('requests_counter', 10, { incorrect: 'incorrect' }),
      ).toThrow();
    });

    it('should set metrics with incorrect index', () => {
      service.incCounter('incorrect', 2);
    });

    it('should add metrics', () => {
      service.incCounter('requests_counter', 3, { path: '/foo/bar' });
    });

    it('should add metrics with incorrect label', () => {
      expect(() =>
        service.incCounter('requests_counter', 2, { incorrect: 'incorrect' }),
      ).toThrow();
    });

    it('should add metrics with incorrect index', () => {
      service.incCounter('incorrect', 2);
    });

    it('should get metrics', async () => {
      const metrics = await service.getAll();

      expect(metrics).toContain('requests_counter{path="/foo/bar"} 13');
    });

    it('should get metrics second time', async () => {
      const metrics = await service.getAll();

      expect(metrics).toContain('requests_counter{path="/foo/bar"} 13');
    });

    it('should clear metrics', async () => {
      await service.clearAll();
      const metrics = await service.getAll();

      expect(metrics).not.toContain('requests_counter{path="/foo/bar"} 13');
    });
  });

  describe('should correctly generate histogram metrics', () => {
    beforeAll(() => {
      vi.clearAllMocks();
      service.clearAll();
      service.registerHistogram(
        'requests_time',
        'all requests time',
        // [0.5, 1, 2, 5],
        ['path'],
      );
    });

    it('should set metrics', () => {
      service.observeHistogram('requests_time', 1.5, { path: '/foo/bar' });
    });

    it("shouldn't set metrics with incorrect label", () => {
      expect(() =>
        service.observeHistogram('requests_time', 10, {
          incorrect: 'incorrect',
        }),
      ).toThrow();
    });

    it('should set metrics with incorrect index', () => {
      service.observeHistogram('incorrect', 2);
    });

    it('should get metrics', async () => {
      const metrics = await service.getAll();

      expect(metrics).toContain(
        'requests_time_bucket{le="2.5",path="/foo/bar"} 1',
      );
    });

    it('should clear metrics', async () => {
      await service.clearAll();
      const metrics = await service.getAll();

      expect(metrics).not.toContain('requests_time_bucket{');
    });
  });
});
