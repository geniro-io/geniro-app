import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  posted: [] as { emit(event: string, ...args: unknown[]): boolean }[],
  showThrows: false,
}));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeNotification extends Emitter {
    static isSupported(): boolean {
      return true;
    }
    closed = false;
    constructor(readonly options: { title: string; body: string }) {
      super();
      mocks.posted.push(this);
    }
    show(): void {
      if (mocks.showThrows) {
        throw new Error('no notification service');
      }
    }
    close(): void {
      this.closed = true;
    }
  }
  return { Notification: FakeNotification };
});

import { createElectronNotifier } from './notifier';

/**
 * Pins that a posted banner is HELD until the platform is done with it.
 *
 * What the hold protects against — the garbage collector taking an unreferenced
 * `Notification`, and its `click` handler with it — cannot be driven from a
 * spec without `--expose-gc`. The set is the mechanism, so its size is the
 * observable: every case below goes red if `post` stops adding to it or an
 * ending stops removing from it.
 */
describe('createElectronNotifier', () => {
  beforeEach(() => {
    mocks.posted.length = 0;
    mocks.showThrows = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const post = (
    notifier: ReturnType<typeof createElectronNotifier>,
    onClick = vi.fn(),
    onOutcome = vi.fn(),
  ): { banner: EventEmitter; handle: { close(): void } } => {
    const handle = notifier.post(
      { title: 'Geniro', body: 'done' },
      onClick,
      onOutcome,
    );
    return { banner: mocks.posted.at(-1) as EventEmitter, handle };
  };

  it('holds every posted banner — a FINAL one included — until the platform is done with it', () => {
    const notifier = createElectronNotifier();

    post(notifier);
    post(notifier);

    expect(notifier.retainedCount()).toBe(2);
  });

  it('lets go of a banner the user CLICKED, and still acts on the click', () => {
    const notifier = createElectronNotifier();
    const onClick = vi.fn();
    const { banner } = post(notifier, onClick);

    banner.emit('click');

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(notifier.retainedCount()).toBe(0);
  });

  it('lets go of a banner the user dismissed', () => {
    const notifier = createElectronNotifier();
    const { banner } = post(notifier);

    banner.emit('close');

    expect(notifier.retainedCount()).toBe(0);
  });

  it('lets go of a banner the platform REFUSED, and reports why', () => {
    const notifier = createElectronNotifier();
    const onOutcome = vi.fn();
    const { banner } = post(notifier, vi.fn(), onOutcome);

    banner.emit('failed', {}, 'not authorised');

    expect(onOutcome).toHaveBeenCalledWith({
      shown: false,
      error: 'not authorised',
    });
    expect(notifier.retainedCount()).toBe(0);
  });

  it('keeps holding a banner the platform merely SHOWED', () => {
    // `show` is where most banners stop hearing from the platform: they time
    // out into Notification Centre and can be clicked from there much later.
    const notifier = createElectronNotifier();
    const { banner } = post(notifier);

    banner.emit('show');

    expect(notifier.retainedCount()).toBe(1);
  });

  it('lets go of a banner this app withdrew itself', () => {
    const notifier = createElectronNotifier();
    const { handle } = post(notifier);

    handle.close();

    expect(notifier.retainedCount()).toBe(0);
  });

  it('lets go after the safety bound, when the platform never says anything', () => {
    vi.useFakeTimers();
    const notifier = createElectronNotifier(1_000);
    post(notifier);

    vi.advanceTimersByTime(999);
    expect(notifier.retainedCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(notifier.retainedCount()).toBe(0);
  });

  it('holds nothing for a banner that could not be shown at all', () => {
    const notifier = createElectronNotifier();
    mocks.showThrows = true;

    expect(() => post(notifier)).toThrow(/no notification service/);
    expect(notifier.retainedCount()).toBe(0);
  });
});
