import { describe, expect, it } from 'vitest';

import { readSettingsNoticeRow } from './settings-notice-payload';

describe('readSettingsNoticeRow', () => {
  it('reads the notice a manager-chat row stands for', () => {
    expect(
      readSettingsNoticeRow({
        severity: 'info',
        message: 'A Geniro update is available',
        woke: false,
        settingsNotice: {
          noticeId: 'n1',
          kind: 'app-update',
          key: 'app-update',
        },
      }),
    ).toEqual({ noticeId: 'n1', kind: 'app-update', key: 'app-update' });
  });

  it('reads no notice from a row without one, or with a kind it does not know', () => {
    expect(readSettingsNoticeRow({ message: 'Started' })).toBeNull();
    expect(readSettingsNoticeRow(null)).toBeNull();
    expect(
      readSettingsNoticeRow({
        settingsNotice: { noticeId: 'n1', kind: 'printer', key: 'printer' },
      }),
    ).toBeNull();
    expect(
      readSettingsNoticeRow({
        settingsNotice: { noticeId: 7, kind: 'app-update', key: 'app-update' },
      }),
    ).toBeNull();
  });
});
