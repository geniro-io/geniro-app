import { act } from 'react';

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
    let onPop: () => void = () => undefined;
    const popped = new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} raised no popstate`)),
        2000,
      );
      onPop = () => {
        clearTimeout(timer);
        resolve();
      };
      window.addEventListener('popstate', onPop, { once: true });
    });
    try {
      go();
    } catch (err) {
      // Disarmed, or the timer would reject later, blamed on another test.
      clearTimeout(timer);
      window.removeEventListener('popstate', onPop);
      throw err;
    }
    await popped;
  });
}
