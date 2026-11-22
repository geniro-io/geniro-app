// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { afterPopstate } from './after-popstate';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('afterPopstate', () => {
  beforeEach(() => {
    window.history.pushState({ entry: 1 }, '');
  });

  describe('under fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('resolves once the traversal delivers its popstate', async () => {
      const popped = vi.fn();
      window.addEventListener('popstate', popped, { once: true });
      await afterPopstate(() => window.history.back());
      expect(popped).toHaveBeenCalledTimes(1);
    });

    it('fails by name at once when go raises no popstate', async () => {
      const started = performance.now();
      await expect(
        afterPopstate(() => undefined, 'closing the sheet'),
      ).rejects.toThrow('closing the sheet raised no popstate');
      expect(performance.now() - started).toBeLessThan(1000);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('under real timers', () => {
    it('resolves once the traversal delivers its popstate', async () => {
      await expect(
        afterPopstate(() => window.history.back()),
      ).resolves.toBeUndefined();
    });
  });
});
