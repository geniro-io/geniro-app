import { afterEach, describe, expect, it, vi } from 'vitest';

import { reportUncaughtErrors } from './uncaught-error-report';

describe('reportUncaughtErrors', () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('reports the stack of an uncaught error, with where it came from', () => {
    const report = vi.fn();
    dispose = reportUncaughtErrors(report);
    const error = new Error('setTypeOfService EINVAL');

    process.emit('uncaughtExceptionMonitor', error, 'uncaughtException');

    expect(report).toHaveBeenCalledWith(
      expect.stringContaining(error.stack ?? 'missing stack'),
      { origin: 'uncaughtException' },
    );
  });

  it('only monitors: it never becomes a handler that would hide the dialog', () => {
    // An `uncaughtException` listener counts as handling the error, which turns
    // off Electron's dialog for every error, not just a known one.
    const handlers = process.listenerCount('uncaughtException');
    const monitors = process.listenerCount('uncaughtExceptionMonitor');

    dispose = reportUncaughtErrors(vi.fn());

    expect(process.listenerCount('uncaughtException')).toBe(handlers);
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(
      monitors + 1,
    );
  });

  it('swallows a report that throws, so the error is not joined by a second one', () => {
    dispose = reportUncaughtErrors(() => {
      throw new Error('the daemon is gone');
    });

    expect(() =>
      process.emit(
        'uncaughtExceptionMonitor',
        new Error('boom'),
        'unhandledRejection',
      ),
    ).not.toThrow();
  });
});
