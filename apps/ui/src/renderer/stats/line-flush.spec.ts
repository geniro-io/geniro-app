// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPreloadStub } from '../__fixtures__/preload-stub';
import { answerLineFlush, registerLineFlush } from './line-flush';

const mocks = vi.hoisted(() => ({
  report: vi.fn(),
}));

vi.mock('../debug/report-ui-errors', () => ({
  reportRendererIssue: mocks.report,
}));

/** Every id main was answered under, in the order the window answered. */
let answered: string[] = [];
/** Each registration a test made, unregistered after it so no test sees another's flush. */
let unregisters: (() => void)[] = [];

function register(flush: () => Promise<void>): void {
  unregisters.push(registerLineFlush(flush));
}

beforeEach(() => {
  answered = [];
  unregisters = [];
  mocks.report.mockReset();
  window.geniro = createPreloadStub({
    lineMeasurementsFlushed: async (requestId: string) => {
      answered.push(requestId);
    },
  });
});

afterEach(() => {
  for (const unregister of unregisters) {
    unregister();
  }
  vi.restoreAllMocks();
});

describe('answerLineFlush', () => {
  it('answers at once when no mounted hook holds a measurement', async () => {
    answerLineFlush('quit-1');

    await vi.waitFor(() => {
      expect(answered).toEqual(['quit-1']);
    });
  });

  it('answers only after every registered flush has finished posting', async () => {
    // One promise, resolved when the test opens the gate: a flush is called again on every quit, so a
    // promise created per call would never settle on the second quit.
    const gate: { open?: () => void } = {};
    const posted = new Promise<void>((resolve) => {
      gate.open = resolve;
    });
    register(() => posted);

    answerLineFlush('quit-2');
    await Promise.resolve();
    expect(answered).toEqual([]);

    gate.open?.();
    await vi.waitFor(() => {
      expect(answered).toEqual(['quit-2']);
    });
  });

  it('reports a flush that failed, and still answers so the quit is not held', async () => {
    register(() => Promise.reject(new Error('daemon unreachable')));

    answerLineFlush('quit-3');

    await vi.waitFor(() => {
      expect(answered).toEqual(['quit-3']);
    });
    expect(mocks.report).toHaveBeenCalledWith(
      'a line measurement was not posted for the quit',
      { error: 'daemon unreachable' },
    );
  });

  it('reports an answer main could not be given, rather than leaving it unhandled', async () => {
    window.geniro = createPreloadStub({
      lineMeasurementsFlushed: () => Promise.reject(new Error('ipc closed')),
    });

    answerLineFlush('quit-5');

    await vi.waitFor(() => {
      expect(mocks.report).toHaveBeenCalledWith(
        'could not answer a quit-time flush',
        { error: 'ipc closed' },
      );
    });
  });

  it('stops holding a flush once its hook has unmounted', async () => {
    // A flush that never settles: if the unregister did not drop it, the quit would wait on it forever.
    const unregister = registerLineFlush(
      () => new Promise<void>(() => undefined),
    );
    unregister();

    answerLineFlush('quit-4');

    await vi.waitFor(() => {
      expect(answered).toEqual(['quit-4']);
    });
  });
});
