import { describe, expect, it, vi } from 'vitest';

import { IPC } from '../shared/contracts';
import {
  notifySettingsChanged,
  type SettingsNotifyTarget,
} from './settings-changed-notify';

function target(destroyed = false, send = vi.fn()): SettingsNotifyTarget {
  return {
    isDestroyed: () => destroyed,
    webContents: { send } as unknown as SettingsNotifyTarget['webContents'],
  };
}

describe('notifySettingsChanged', () => {
  it('tells every live window, and skips a destroyed one', () => {
    const live = vi.fn();
    const gone = vi.fn();

    notifySettingsChanged([target(false, live), target(true, gone)]);

    expect(live).toHaveBeenCalledWith(IPC.onSettingsChanged);
    expect(gone).not.toHaveBeenCalled();
  });

  it('carries on to the next window when a send throws', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const next = vi.fn();

    notifySettingsChanged([
      target(
        false,
        vi.fn(() => {
          throw new Error('Object has been destroyed');
        }),
      ),
      target(false, next),
    ]);

    expect(next).toHaveBeenCalledWith(IPC.onSettingsChanged);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
