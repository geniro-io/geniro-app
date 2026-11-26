import { describe, expect, it } from 'vitest';

import type { ConfigProfile } from '../../shared/contracts';
import {
  updateState,
  waitingShare,
} from '../__tests__/settings-attention-fixtures';
import {
  appUpdateWaits,
  configDirName,
  dismissFlagKey,
  isFolded,
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

describe('dismissFlagKey', () => {
  it('keys a dismissal by its card and its item', () => {
    expect(dismissFlagKey('app-update', '2.4.0')).toBe(
      'settings-attention-dismissed:app-update:2.4.0',
    );
  });
});

describe('isFolded', () => {
  const card = 'agent-updates';
  const flagged = (flags: Record<string, boolean>) => (key: string) =>
    flags[key] ?? null;
  const key = (item: string) => dismissFlagKey(card, item);

  it('never folds a card that shows nothing', () => {
    expect(isFolded(card, [], flagged({}))).toBe(false);
  });

  it('folds once every item it shows was dismissed', () => {
    expect(
      isFolded(
        card,
        ['a', 'b'],
        flagged({ [key('a')]: true, [key('b')]: true }),
      ),
    ).toBe(true);
  });

  it('opens for an item that was never dismissed', () => {
    expect(
      isFolded(
        card,
        ['a', 'b', 'c'],
        flagged({ [key('a')]: true, [key('b')]: true }),
      ),
    ).toBe(false);
  });

  it('stays folded when a dismissed item goes away', () => {
    expect(
      isFolded(card, ['a'], flagged({ [key('a')]: true, [key('b')]: true })),
    ).toBe(true);
  });

  it('opens again once its items were shown again', () => {
    expect(isFolded(card, ['a'], flagged({ [key('a')]: false }))).toBe(false);
  });

  it('reads a dismissal of another card as not dismissed here', () => {
    expect(
      isFolded(
        card,
        ['a'],
        flagged({ [dismissFlagKey('app-update', 'a')]: true }),
      ),
    ).toBe(false);
  });
});
