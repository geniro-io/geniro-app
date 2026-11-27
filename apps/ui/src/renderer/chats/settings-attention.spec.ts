import { describe, expect, it } from 'vitest';

import type { ConfigProfile } from '../../shared/contracts';
import {
  detection,
  updateAvailable,
  updateState,
  waitingShare,
} from '../__tests__/settings-attention-fixtures';
import {
  appUpdateWaits,
  configDirName,
  reportedNoticeReadings,
  shareWaitOf,
  shareWaitsByPlace,
} from './settings-attention';

describe('shareWaitsByPlace', () => {
  it('folds every waiting share of one place into one entry, counting them', () => {
    expect(
      shareWaitsByPlace([
        waitingShare('s1', 'gcs', 'Google Cloud'),
        waitingShare('s2', 'gcs', 'Google Cloud'),
        waitingShare('s3', 's3', 'Amazon S3'),
      ]),
    ).toEqual([
      {
        destinationId: 's3',
        label: 'Amazon S3',
        reason: 'Sign-in required (gcloud)',
        count: 1,
        shareIds: ['s3'],
      },
      {
        destinationId: 'gcs',
        label: 'Google Cloud',
        reason: 'Sign-in required (gcloud)',
        count: 2,
        shareIds: ['s1', 's2'],
      },
    ]);
  });

  it('leaves out shares that wait on nothing', () => {
    expect(
      shareWaitsByPlace([
        waitingShare('s1', 'gcs', 'Google Cloud', 'live'),
        waitingShare('s2', 'gcs', 'Google Cloud', 'failed'),
      ]),
    ).toEqual([]);
  });
});

describe('appUpdateWaits', () => {
  it('waits for an update this install can apply, one under way and one installed', () => {
    expect(appUpdateWaits(updateState({ phase: 'available' }))).toBe(true);
    expect(appUpdateWaits(updateState({ phase: 'downloading' }))).toBe(true);
    expect(appUpdateWaits(updateState({ phase: 'installing' }))).toBe(true);
    expect(appUpdateWaits(updateState({ phase: 'ready' }))).toBe(true);
  });

  it('does not wait for an update this install cannot apply, a check or nothing', () => {
    expect(
      appUpdateWaits(updateState({ phase: 'available', canInstall: false })),
    ).toBe(false);
    expect(appUpdateWaits(updateState({ phase: 'checking' }))).toBe(false);
    expect(appUpdateWaits(updateState({ phase: 'up-to-date' }))).toBe(false);
    expect(appUpdateWaits(null)).toBe(false);
  });
});

describe('configDirName', () => {
  it('names a configuration by its saved name, else by its folder', () => {
    const profiles: ConfigProfile[] = [
      {
        id: 'p',
        name: 'Work',
        agent: 'claude',
        dir: '/cfg/work',
        color: 'blue',
      },
    ];
    expect(configDirName('/cfg/work', profiles)).toBe('Work');
    expect(configDirName('/cfg/home/', profiles)).toBe('home');
  });
});

describe('reportedNoticeReadings', () => {
  it('leaves out what Electron main has not read yet', () => {
    expect(reportedNoticeReadings(null, null)).toEqual([]);
  });

  it('names the Geniro version, each CLI update and each signed-out account as the notices key them', () => {
    expect(
      reportedNoticeReadings(
        [
          detection('claude', { update: updateAvailable('2.0.0') }),
          detection('codex', {
            loggedIn: false,
            profileLogins: { '/cfg/work': false },
          }),
        ],
        updateState({ phase: 'available', version: '2.4.0' }),
      ),
    ).toEqual([
      { kind: 'app-update', items: ['2.4.0'] },
      { kind: 'agent-updates', items: ['claude@2.0.0'] },
      { kind: 'agent-sign-in', items: ['codex:', 'codex:/cfg/work'] },
    ]);
  });

  it('reports a kind it read with nothing waiting as empty, so its notice closes', () => {
    expect(
      reportedNoticeReadings(
        [detection('claude')],
        updateState({ phase: 'up-to-date' }),
      ),
    ).toEqual([
      { kind: 'app-update', items: [] },
      { kind: 'agent-updates', items: [] },
      { kind: 'agent-sign-in', items: [] },
    ]);
  });
});

describe('shareWaitOf', () => {
  it('finds the place a share-sign-in notice is keyed by', () => {
    const waits = shareWaitsByPlace([
      waitingShare('s1', 'gcs', 'Google Cloud'),
      waitingShare('s2', 'aws', 'Amazon S3'),
    ]);
    expect(shareWaitOf(waits, 'share-sign-in:gcs')?.label).toBe('Google Cloud');
    expect(shareWaitOf(waits, 'share-sign-in:azure')).toBeNull();
  });
});
