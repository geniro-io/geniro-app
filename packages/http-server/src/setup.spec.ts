import type { INestApplication } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { runHttpApp, validateOperationIdUniqueness } from './setup';

describe('validateOperationIdUniqueness', () => {
  it('passes for an empty paths object', () => {
    expect(() => validateOperationIdUniqueness({ paths: {} })).not.toThrow();
  });

  it('passes when paths is undefined', () => {
    expect(() => validateOperationIdUniqueness({})).not.toThrow();
  });

  it('passes when all operationIds are unique across paths and verbs', () => {
    expect(() =>
      validateOperationIdUniqueness({
        paths: {
          '/things': {
            get: { operationId: 'listThings' },
            post: { operationId: 'createThing' },
          },
          '/things/{id}': {
            get: { operationId: 'getThingById' },
            put: { operationId: 'updateThing' },
            delete: { operationId: 'deleteThing' },
          },
        },
      }),
    ).not.toThrow();
  });

  it('throws when two GET handlers on different paths share the same operationId', () => {
    expect(() =>
      validateOperationIdUniqueness({
        paths: {
          '/widgets': {
            get: { operationId: 'getAll' },
          },
          '/gadgets': {
            get: { operationId: 'getAll' },
          },
        },
      }),
    ).toThrow(/Duplicate operationIds detected/);
  });

  it('includes both conflicting refs in the error message', () => {
    let caught: Error | undefined;
    try {
      validateOperationIdUniqueness({
        paths: {
          '/widgets': {
            get: { operationId: 'getAll' },
          },
          '/gadgets': {
            get: { operationId: 'getAll' },
          },
        },
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toContain('GET /widgets');
    expect(caught?.message).toContain('GET /gadgets');
    expect(caught?.message).toContain('"getAll"');
  });

  it('throws and lists all three refs for a three-way collision', () => {
    let caught: Error | undefined;
    try {
      validateOperationIdUniqueness({
        paths: {
          '/a': { get: { operationId: 'getAll' } },
          '/b': { get: { operationId: 'getAll' } },
          '/c': { get: { operationId: 'getAll' } },
        },
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toContain('GET /a');
    expect(caught?.message).toContain('GET /b');
    expect(caught?.message).toContain('GET /c');
  });

  it('includes a Fix: hint in the error message', () => {
    let caught: Error | undefined;
    try {
      validateOperationIdUniqueness({
        paths: {
          '/x': { post: { operationId: 'create' } },
          '/y': { post: { operationId: 'create' } },
        },
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).toContain('Fix:');
    expect(caught?.message).toContain('@ApiOperation');
  });

  it('handles a path entry whose value is null without false positive', () => {
    expect(() =>
      validateOperationIdUniqueness({
        paths: {
          '/fine': {
            get: { operationId: 'getFine' },
          },
          // null value — malformed but must not crash or produce false positive
          '/bad': null as unknown as Record<string, unknown>,
        },
      }),
    ).not.toThrow();
  });

  it('handles a path entry whose value is a non-object primitive without false positive', () => {
    expect(() =>
      validateOperationIdUniqueness({
        paths: {
          '/fine': { get: { operationId: 'getFine' } },
          '/also-bad': 'not-an-object' as unknown as Record<string, unknown>,
        },
      }),
    ).not.toThrow();
  });

  it('handles operations without an operationId field gracefully', () => {
    expect(() =>
      validateOperationIdUniqueness({
        paths: {
          '/no-id': {
            get: { summary: 'no operationId here' },
          },
        },
      }),
    ).not.toThrow();
  });
});

// The port-fallback options (portFallback / onListening / host) are this
// repo's own additions to the vendored package and the daemon-boot mainline
// when the preferred port is taken: the pidfile rendezvous depends on the
// BOUND port being reported, never the preferred one.
describe('runHttpApp', () => {
  function stubApp(behavior: {
    failListens?: NodeJS.ErrnoException[];
    boundPort: number;
  }): { app: INestApplication; listens: [number, string][] } {
    const failures = [...(behavior.failListens ?? [])];
    const listens: [number, string][] = [];
    const app = {
      listen: vi.fn(async (port: number, host: string) => {
        listens.push([port, host]);
        const failure = failures.shift();
        if (failure) {
          throw failure;
        }
      }),
      getHttpAdapter: () => ({
        getInstance: () => ({
          server: { address: () => ({ port: behavior.boundPort }) },
        }),
      }),
      get: () => ({ log: vi.fn() }),
    } as unknown as INestApplication;
    return { app, listens };
  }

  function errnoError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(code), { code });
  }

  it('falls back to listen(0) on EADDRINUSE and reports the BOUND port to onListening', async () => {
    const { app, listens } = stubApp({
      failListens: [errnoError('EADDRINUSE')],
      boundPort: 51_234,
    });
    const onListening = vi.fn();

    await runHttpApp(app, {
      port: 47_615,
      host: '127.0.0.1',
      portFallback: true,
      onListening,
    });

    expect(listens).toEqual([
      [47_615, '127.0.0.1'],
      [0, '127.0.0.1'],
    ]);
    expect(onListening).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 51_234,
    });
  });

  it('without portFallback an EADDRINUSE propagates and onListening never fires', async () => {
    const { app, listens } = stubApp({
      failListens: [errnoError('EADDRINUSE')],
      boundPort: 47_615,
    });
    const onListening = vi.fn();

    await expect(
      runHttpApp(app, { port: 47_615, host: '127.0.0.1', onListening }),
    ).rejects.toThrow('EADDRINUSE');
    expect(listens).toHaveLength(1);
    expect(onListening).not.toHaveBeenCalled();
  });

  it('a non-EADDRINUSE listen error propagates even with portFallback', async () => {
    const { app, listens } = stubApp({
      failListens: [errnoError('EACCES')],
      boundPort: 47_615,
    });

    await expect(
      runHttpApp(app, { port: 47_615, host: '127.0.0.1', portFallback: true }),
    ).rejects.toThrow('EACCES');
    expect(listens).toHaveLength(1);
  });

  it('a clean listen reports the bound port without a fallback attempt', async () => {
    const { app, listens } = stubApp({ boundPort: 47_615 });
    const onListening = vi.fn();

    await runHttpApp(app, {
      port: 47_615,
      host: '127.0.0.1',
      portFallback: true,
      onListening,
    });

    expect(listens).toEqual([[47_615, '127.0.0.1']]);
    expect(onListening).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 47_615,
    });
  });
});
