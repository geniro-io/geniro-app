import { describe, expect, it, vi } from 'vitest';

import type { RunNotification } from '../../shared/contracts';
import {
  NotificationService,
  type NotificationWindow,
} from './notifications.service';
import type { Notifier } from './notifier';

const notification: RunNotification = {
  kind: 'question',
  runId: 'run-1',
  title: 'Refactor the parser',
  body: 'Waiting for your answer.',
};

/** A notifier double that records what it was asked to post and replays a click. */
function fakeNotifier(
  supported = true,
  /** What the platform reports back, as macOS does asynchronously. */
  outcome: { shown: boolean; error: string | null } | null = {
    shown: true,
    error: null,
  },
): Notifier & {
  posted: { title: string; body: string }[];
  click(): void;
} {
  const posted: { title: string; body: string }[] = [];
  let onClick: (() => void) | null = null;
  return {
    posted,
    isSupported: () => supported,
    post: (options, listener, onOutcome) => {
      posted.push(options);
      onClick = listener;
      if (outcome !== null) {
        onOutcome?.(outcome);
      }
    },
    click: () => {
      if (onClick === null) {
        throw new Error('clicked a banner that was never posted');
      }
      onClick();
    },
  };
}

function fakeWindow(
  overrides: Partial<NotificationWindow> = {},
): NotificationWindow & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    ...overrides,
  } as NotificationWindow & { calls: string[] };
}

describe('NotificationService', () => {
  it('posts a banner carrying the thread name and the reason', () => {
    const notifier = fakeNotifier();
    const service = new NotificationService(
      () => ({ notificationsEnabled: true }),
      notifier,
    );

    const posted = service.post(notification, {
      window: fakeWindow(),
      onActivate: vi.fn(),
    });

    expect(posted).toBe(true);
    expect(notifier.posted).toEqual([
      { title: 'Refactor the parser', body: 'Waiting for your answer.' },
    ]);
  });

  it('posts NOTHING when the user switched notifications off', () => {
    const notifier = fakeNotifier();
    const service = new NotificationService(
      () => ({ notificationsEnabled: false }),
      notifier,
    );

    expect(
      service.post(notification, {
        window: fakeWindow(),
        onActivate: vi.fn(),
      }),
    ).toBe(false);
    // The gate is before the notifier is even reached — the whole reason the
    // decision lives here rather than in the renderer.
    expect(notifier.posted).toEqual([]);
  });

  it('reads the setting at POST time, so a flipped switch applies at once', () => {
    // The pin for "no cached copy of the toggle": one service instance, one
    // notifier, and the answer changes underneath it between two posts.
    let enabled = true;
    const notifier = fakeNotifier();
    const service = new NotificationService(
      () => ({ notificationsEnabled: enabled }),
      notifier,
    );
    const target = { window: fakeWindow(), onActivate: vi.fn() };

    expect(service.post(notification, target)).toBe(true);
    enabled = false;
    expect(service.post(notification, target)).toBe(false);
    enabled = true;
    expect(service.post(notification, target)).toBe(true);
    expect(notifier.posted).toHaveLength(2);
  });

  it('posts nothing on a system that cannot show notifications', () => {
    const notifier = fakeNotifier(false);
    const service = new NotificationService(
      () => ({ notificationsEnabled: true }),
      notifier,
    );

    expect(
      service.post(notification, {
        window: fakeWindow(),
        onActivate: vi.fn(),
      }),
    ).toBe(false);
    expect(notifier.posted).toEqual([]);
  });

  it('raises the window and reports the run when the banner is clicked', () => {
    const notifier = fakeNotifier();
    const service = new NotificationService(
      () => ({ notificationsEnabled: true }),
      notifier,
    );
    const window = fakeWindow();
    const onActivate = vi.fn();

    service.post(notification, { window, onActivate });
    notifier.click();

    expect(window.calls).toEqual(['show', 'focus']);
    expect(onActivate).toHaveBeenCalledWith('run-1');
  });

  it('un-minimizes first — show/focus alone leave a minimized window down', () => {
    const notifier = fakeNotifier();
    const service = new NotificationService(
      () => ({ notificationsEnabled: true }),
      notifier,
    );
    const window = fakeWindow({ isMinimized: () => true });

    service.post(notification, { window, onActivate: vi.fn() });
    notifier.click();

    expect(window.calls).toEqual(['restore', 'show', 'focus']);
  });

  it('still reports the run when the window is gone by the time it is clicked', () => {
    const notifier = fakeNotifier();
    const service = new NotificationService(
      () => ({ notificationsEnabled: true }),
      notifier,
    );
    const onActivate = vi.fn();
    const window = fakeWindow({
      isDestroyed: () => true,
      // Reaching into a destroyed window throws, and that throw would land
      // inside the OS click callback.
      show: () => {
        throw new Error('window destroyed');
      },
    });

    service.post(notification, { window, onActivate });

    expect(() => notifier.click()).not.toThrow();
    expect(onActivate).toHaveBeenCalledWith('run-1');
  });

  it('reports the run when the sender has no window at all', () => {
    const notifier = fakeNotifier();
    const service = new NotificationService(
      () => ({ notificationsEnabled: true }),
      notifier,
    );
    const onActivate = vi.fn();

    service.post(notification, { window: null, onActivate });
    notifier.click();

    expect(onActivate).toHaveBeenCalledWith('run-1');
  });

  it('swallows a banner the platform refused to construct', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const service = new NotificationService(
      () => ({ notificationsEnabled: true }),
      {
        isSupported: () => true,
        post: () => {
          throw new Error('no notification centre');
        },
      },
    );

    // The renderer awaits the IPC call behind this; a throw would surface as a
    // failed request in the middle of a chat, over a banner.
    expect(() =>
      service.post(notification, {
        window: fakeWindow(),
        onActivate: vi.fn(),
      }),
    ).not.toThrow();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('the on-demand test banner', () => {
  const target = (): Parameters<NotificationService['testPost']>[0] => ({
    window: fakeWindow(),
    onActivate: vi.fn(),
  });

  it('reports a banner the platform SHOWED', async () => {
    const service = new NotificationService(
      () => ({ notificationsEnabled: true }),
      fakeNotifier(),
    );

    await expect(service.testPost(target())).resolves.toEqual({
      posted: true,
      shown: true,
      reason: null,
    });
  });

  it('hands back the system’s REFUSAL instead of claiming success', async () => {
    // The whole point of the control: an app macOS has not been authorised for
    // fails here, silently, and every other path in this file would report
    // "posted" and move on.
    const service = new NotificationService(
      () => ({ notificationsEnabled: true }),
      fakeNotifier(true, { shown: false, error: 'not authorized' }),
    );

    const result = await service.testPost(target());

    expect(result).toMatchObject({ posted: true, shown: false });
    expect(result.reason).toContain('not authorized');
  });

  it('does not call a silent platform a failure', async () => {
    // Neither event fired. The banner may well be in Notification Centre, and
    // telling the user it failed would be the wrong half of the truth.
    const service = new NotificationService(
      () => ({ notificationsEnabled: true }),
      fakeNotifier(true, null),
    );

    const result = await service.testPost(target());

    expect(result).toMatchObject({ posted: true, shown: null });
    expect(result.reason).toContain('did not report back');
  }, 10_000);

  it('says it is the SETTING when the switch is off, and posts nothing', async () => {
    const notifier = fakeNotifier();
    const service = new NotificationService(
      () => ({ notificationsEnabled: false }),
      notifier,
    );

    const result = await service.testPost(target());

    expect(result).toMatchObject({ posted: false, shown: null });
    expect(result.reason).toContain('switched off');
    expect(notifier.posted).toHaveLength(0);
  });
});
