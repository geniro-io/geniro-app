import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_LOOP_BLOCK_WARN_MS,
  EventLoopWatchdogService,
} from './event-loop-watchdog.service';

function blockFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Holds the event loop the way a chain of synchronous queries does.
  }
}

function turn(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('EventLoopWatchdogService', () => {
  const watchdog = new EventLoopWatchdogService();

  afterEach(() => {
    watchdog.onModuleDestroy();
    vi.restoreAllMocks();
  });

  it('warns with how long the loop could not turn once it turns again', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    watchdog.onModuleInit();
    await turn();

    blockFor(EVENT_LOOP_BLOCK_WARN_MS + 200);
    await turn();
    watchdog.check();

    expect(warn).toHaveBeenCalledTimes(1);
    const [line] = warn.mock.calls[0]!;
    const blocked = Number(/blocked for (\d+) ms/.exec(String(line))?.[1]);
    expect(blocked).toBeGreaterThanOrEqual(EVENT_LOOP_BLOCK_WARN_MS);
  });

  it('stays quiet while the loop keeps turning', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    watchdog.onModuleInit();
    await turn(200);

    watchdog.check();

    expect(warn).not.toHaveBeenCalled();
  });
});
