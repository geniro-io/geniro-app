import { describe, expect, it, vi } from 'vitest';

import {
  NOTIFICATION_SETTINGS_URL,
  openNotificationSettings,
} from './notification-settings';

describe('openNotificationSettings', () => {
  it('asks the OS for the Notifications pane by its CURRENT identifier', () => {
    // Read off the pane's own manifest on macOS 26.6.1
    // (`/System/Library/ExtensionKit/Extensions/NotificationsSettings.appex`),
    // whose `CFBundleIdentifier` this is and whose
    // `allowsXAppleSystemPreferencesURLScheme` is what makes the scheme resolve
    // at all. The pre-Ventura `com.apple.preference.notifications` is only its
    // `legacyBundleIdentifier` — an alias, and the half Apple eventually drops.
    expect(NOTIFICATION_SETTINGS_URL).toBe(
      'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
    );
  });

  it('takes no destination from its caller', async () => {
    // The security half, and the reason this is a function rather than a value
    // handed to `shell.openExternal` at the call site: `openExternal` on
    // caller-supplied input is the Electron checklist's #14, and the renderer's
    // channel carries no argument. A renderer that could name an
    // `x-apple.systempreferences:` target could aim the user at any pane on the
    // machine.
    const open = vi.fn(async () => undefined);
    await openNotificationSettings(open);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(NOTIFICATION_SETTINGS_URL);
  });

  it('propagates a refusal rather than reporting a pane it never opened', async () => {
    // `shell.openExternal` rejects when the scheme has no handler. Swallowing
    // that would leave the button indistinguishable from one that worked.
    await expect(
      openNotificationSettings(() => Promise.reject(new Error('no handler'))),
    ).rejects.toThrow('no handler');
  });
});
