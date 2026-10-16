import { afterEach } from 'vitest';

import { sleepWatch } from '../utils/sleep-watch';

// The daemon's sleep watch is module-scope, and a spec's turns routinely end
// without settling — so each test starts with no ticker inherited from the one
// before (see `SleepWatch.reset`).
afterEach(() => {
  sleepWatch.reset();
});
