import { afterAll, afterEach, vi } from 'vitest';

import { watchProcessState } from './process-state-guard';

// Files share one worker process (`isolate: false`), so each file starts on an
// empty module registry: a spec's `vi.mock` only reaches a module evaluated
// after it registers, never one an earlier file already loaded.
vi.resetModules();
const { sleepWatch } = await import('../utils/sleep-watch');

const stateLeftBehind = watchProcessState();

afterEach(() => {
  sleepWatch.reset();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  const leaks = stateLeftBehind();
  if (leaks.length > 0) {
    throw new Error(
      `This spec file left state behind for the next file in its worker: ${leaks.join('; ')}`,
    );
  }
});
