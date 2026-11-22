import { act } from 'react';
import { vi } from 'vitest';

/**
 * Run `go` and wait for the `popstate` it raises. jsdom delivers a history
 * traversal on a later task, so a press that pops history is only finished
 * once that event has run — and a `go` that raises none (a page that closed
 * itself instead of going back through history) fails here, by name.
 */
export async function afterPopstate(
  go: () => void,
  what = 'the action',
): Promise<void> {
  await act(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fired = false;
    let onPop: () => void = () => undefined;
    const noPopstate = () => new Error(`${what} raised no popstate`);
    const popped = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(noPopstate()), 2000);
      onPop = () => {
        fired = true;
        clearTimeout(timer);
        resolve();
      };
      window.addEventListener('popstate', onPop, { once: true });
    });
    // Disarmed, or the timer would reject later, blamed on another test.
    const disarm = () => {
      clearTimeout(timer);
      window.removeEventListener('popstate', onPop);
    };
    try {
      go();
    } catch (err) {
      disarm();
      throw err;
    }
    // jsdom's traversal timer, set during a tick, fires only at 1ms; the fake
    // 2000ms guard would never fire, so a missing popstate fails right here.
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(1);
      if (!fired) {
        disarm();
        throw noPopstate();
      }
    }
    await popped;
  });
}
