// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isStaleBundleError,
  recoverFromStaleBundles,
  reloadForNewBundle,
} from './stale-bundle';

const KEY = 'geniro.staleBundleReloadAt';

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('isStaleBundleError', () => {
  it('recognises every engine’s missing-chunk sentence and vite’s stylesheet one', () => {
    expect(
      isStaleBundleError(
        new TypeError(
          'Failed to fetch dynamically imported module: http://h/assets/A-1.js',
        ),
      ),
    ).toBe(true);
    // Safari's — the sentence the Graphs page reported on a phone.
    expect(
      isStaleBundleError(new TypeError('Importing a module script failed.')),
    ).toBe(true);
    expect(
      isStaleBundleError(
        new TypeError('error loading dynamically imported module: x'),
      ),
    ).toBe(true);
    expect(
      isStaleBundleError(
        new Error('Unable to preload CSS for http://h/assets/Workflows-1.css'),
      ),
    ).toBe(true);
  });

  it('does not take an ordinary crash, or a non-error, for a stale bundle', () => {
    expect(isStaleBundleError(new Error('kaboom'))).toBe(false);
    expect(isStaleBundleError('Importing a module script failed.')).toBe(false);
    expect(isStaleBundleError(undefined)).toBe(false);
  });
});

describe('reloadForNewBundle', () => {
  it('reloads once, and answers "reloading" to the same page asking again', () => {
    const reload = vi.fn();

    expect(reloadForNewBundle(reload, 100, 1_000)).toBe(true);
    expect(reloadForNewBundle(reload, 100, 1_050)).toBe(true);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('refuses a reload moments after the PREVIOUS page reloaded for the same reason', () => {
    const reload = vi.fn();
    reloadForNewBundle(reload, 100, 1_000);

    // The reloaded page — a new origin time — fails the same way at once.
    expect(reloadForNewBundle(reload, 200, 5_000)).toBe(false);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again once the guard window has passed', () => {
    const reload = vi.fn();
    reloadForNewBundle(reload, 100, 1_000);

    expect(reloadForNewBundle(reload, 200, 1_000 + 31_000)).toBe(true);

    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('refuses when storage cannot remember the reload — an unbounded reload is a loop', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const reload = vi.fn();

    expect(reloadForNewBundle(reload, 100, 1_000)).toBe(false);

    expect(reload).not.toHaveBeenCalled();
  });

  it('reads an unreadable stamp as no stamp', () => {
    sessionStorage.setItem(KEY, 'not json');
    const reload = vi.fn();

    expect(reloadForNewBundle(reload, 100, 1_000)).toBe(true);

    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('recoverFromStaleBundles', () => {
  function preloadError(payload: unknown): Event {
    const event = new Event('vite:preloadError', { cancelable: true });
    Reflect.set(event, 'payload', payload);
    return event;
  }

  it('reloads when vite reports a chunk the server no longer has, without swallowing the error', () => {
    const reload = vi.fn();
    const dispose = recoverFromStaleBundles(window, reload);
    const event = preloadError(
      new TypeError('Importing a module script failed.'),
    );

    window.dispatchEvent(event);
    dispose();

    expect(reload).toHaveBeenCalledTimes(1);
    // Not cancelled: the import still rejects, so the view that awaited it
    // shows "Loading the updated app…" rather than resolving to nothing.
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves every other preload failure alone', () => {
    const reload = vi.fn();
    const dispose = recoverFromStaleBundles(window, reload);

    window.dispatchEvent(preloadError(new Error('kaboom')));
    dispose();

    expect(reload).not.toHaveBeenCalled();
  });

  it('stops listening once disposed', () => {
    const reload = vi.fn();
    recoverFromStaleBundles(window, reload)();

    window.dispatchEvent(
      preloadError(new TypeError('Importing a module script failed.')),
    );

    expect(reload).not.toHaveBeenCalled();
  });
});
