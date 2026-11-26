import { describe, expect, it } from 'vitest';

import type { ConfigProfile } from '../../shared/contracts';
import {
  updateState,
  waitingShare,
} from '../__tests__/settings-attention-fixtures';
import {
  appUpdateWaits,
  configDirName,
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
      },
      {
        destinationId: 'gcs',
        label: 'Google Cloud',
        reason: 'Sign-in required (gcloud)',
        count: 2,
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
