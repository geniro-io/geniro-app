import { describe, expect, it } from 'vitest';

import type { SettingsNoticeKind } from '../../agents/chat.types';
import { type OpenNotice, planNotices, readingsByKey } from './notice-plan';

const UPDATE = new Set<SettingsNoticeKind>(['app-update']);

function open(overrides: Partial<OpenNotice> = {}): OpenNotice {
  return {
    id: 'n1',
    kind: 'app-update',
    key: 'app-update',
    items: ['1.4.0'],
    label: null,
    dismissed: false,
    ...overrides,
  };
}

describe('readingsByKey', () => {
  it('keeps the Geniro update one notice, and splits CLI updates per CLI and sign-ins per account', () => {
    expect(readingsByKey('app-update', ['2.4.0'])).toEqual([
      { kind: 'app-update', key: 'app-update', items: ['2.4.0'], label: null },
    ]);
    expect(
      readingsByKey('agent-updates', ['claude@2.0.0', 'codex@0.9.0']),
    ).toEqual([
      {
        kind: 'agent-updates',
        key: 'agent-updates:claude',
        items: ['claude@2.0.0'],
        label: null,
      },
      {
        kind: 'agent-updates',
        key: 'agent-updates:codex',
        items: ['codex@0.9.0'],
        label: null,
      },
    ]);
    expect(readingsByKey('agent-sign-in', ['claude:/cfg/work'])).toEqual([
      {
        kind: 'agent-sign-in',
        key: 'agent-sign-in:claude:/cfg/work',
        items: ['claude:/cfg/work'],
        label: null,
      },
    ]);
    expect(readingsByKey('agent-updates', [])).toEqual([]);
  });
});

describe('planNotices', () => {
  it('opens a notice for a key read with items and none open', () => {
    expect(
      planNotices([], UPDATE, [
        {
          kind: 'app-update',
          key: 'app-update',
          items: ['1.4.0'],
          label: null,
        },
      ]),
    ).toEqual([
      {
        op: 'open',
        reading: {
          kind: 'app-update',
          key: 'app-update',
          items: ['1.4.0'],
          label: null,
        },
      },
    ]);
  });

  it('does nothing when the open notice already shows every item read', () => {
    expect(
      planNotices([open()], UPDATE, [
        {
          kind: 'app-update',
          key: 'app-update',
          items: ['1.4.0'],
          label: null,
        },
      ]),
    ).toEqual([]);
  });

  it('resolves an open notice whose key is read with no items or not at all', () => {
    expect(
      planNotices([open()], UPDATE, [
        { kind: 'app-update', key: 'app-update', items: [], label: null },
      ]),
    ).toEqual([{ op: 'resolve', id: 'n1' }]);
    expect(planNotices([open()], UPDATE, [])).toEqual([
      { op: 'resolve', id: 'n1' },
    ]);
  });

  it('leaves a notice whose key is unsettled as it is, and resolves the others of its kind', () => {
    const work = open({
      id: 'n2',
      kind: 'agent-sign-in',
      key: 'agent-sign-in:claude:/cfg/work',
    });
    const home = open({
      id: 'n3',
      kind: 'agent-sign-in',
      key: 'agent-sign-in:claude:',
    });
    expect(
      planNotices(
        [work, home],
        new Set<SettingsNoticeKind>(['agent-sign-in']),
        [],
        new Set(['agent-sign-in:claude:/cfg/work']),
      ),
    ).toEqual([{ op: 'resolve', id: 'n3' }]);
  });

  it('leaves the notices of kinds this reading did not cover alone', () => {
    expect(
      planNotices([open()], new Set<SettingsNoticeKind>(['agent-updates']), []),
    ).toEqual([]);
  });

  it('moves an undismissed notice in place to what its key holds now', () => {
    expect(
      planNotices([open()], UPDATE, [
        {
          kind: 'app-update',
          key: 'app-update',
          items: ['1.5.0'],
          label: null,
        },
      ]),
    ).toEqual([{ op: 'update', id: 'n1', items: ['1.5.0'], label: null }]);
  });

  it('narrows an undismissed storage notice to the shares that still wait, and takes its new name', () => {
    const kinds = new Set<SettingsNoticeKind>(['share-sign-in']);
    const gcloud = open({
      kind: 'share-sign-in',
      key: 'share-sign-in:gcloud',
      items: ['s1', 's2'],
      label: 'Google Cloud',
    });
    expect(
      planNotices([gcloud], kinds, [
        {
          kind: 'share-sign-in',
          key: 'share-sign-in:gcloud',
          items: ['s2'],
          label: 'Google Cloud',
        },
      ]),
    ).toEqual([
      { op: 'update', id: 'n1', items: ['s2'], label: 'Google Cloud' },
    ]);
    expect(
      planNotices([gcloud], kinds, [
        {
          kind: 'share-sign-in',
          key: 'share-sign-in:gcloud',
          items: ['s2', 's1'],
          label: 'Team bucket',
        },
      ]),
    ).toEqual([
      { op: 'update', id: 'n1', items: ['s2', 's1'], label: 'Team bucket' },
    ]);
  });

  it('keeps what a dismissed notice showed while fewer of its items wait', () => {
    expect(
      planNotices(
        [
          open({
            kind: 'share-sign-in',
            key: 'share-sign-in:gcloud',
            items: ['s1', 's2'],
            dismissed: true,
          }),
        ],
        new Set<SettingsNoticeKind>(['share-sign-in']),
        [
          {
            kind: 'share-sign-in',
            key: 'share-sign-in:gcloud',
            items: ['s1'],
            label: null,
          },
        ],
      ),
    ).toEqual([]);
  });

  it('replaces a dismissed notice with a new one when a new item appears', () => {
    const reading = {
      kind: 'app-update' as const,
      key: 'app-update',
      items: ['1.5.0'],
      label: null,
    };
    expect(planNotices([open({ dismissed: true })], UPDATE, [reading])).toEqual(
      [
        { op: 'resolve', id: 'n1' },
        { op: 'open', reading },
      ],
    );
  });

  it('keeps a dismissed notice dismissed while only items it showed come back', () => {
    expect(
      planNotices([open({ dismissed: true, items: ['1.4.0'] })], UPDATE, [
        {
          kind: 'app-update',
          key: 'app-update',
          items: ['1.4.0'],
          label: null,
        },
      ]),
    ).toEqual([]);
  });

  it('keeps a dismissed notice of many items dismissed across repeated readings of them', () => {
    const items = Array.from({ length: 450 }, (_, index) => `f${index}`);
    const kinds = new Set<SettingsNoticeKind>(['memory-conflicts']);
    const reading = {
      kind: 'memory-conflicts' as const,
      key: 'memory-conflicts',
      items,
      label: null,
    };
    const dismissed = open({
      kind: 'memory-conflicts',
      key: 'memory-conflicts',
      items,
      dismissed: true,
    });

    expect(planNotices([dismissed], kinds, [reading])).toEqual([]);
    expect(planNotices([dismissed], kinds, [reading])).toEqual([]);
  });

  it('resolves every open notice of a key beyond the first', () => {
    expect(
      planNotices([open(), open({ id: 'n2' })], UPDATE, [
        {
          kind: 'app-update',
          key: 'app-update',
          items: ['1.4.0'],
          label: null,
        },
      ]),
    ).toEqual([{ op: 'resolve', id: 'n2' }]);
  });

  it('keys the notices of one kind apart', () => {
    const kinds = new Set<SettingsNoticeKind>(['share-sign-in']);
    const gcloud = open({
      kind: 'share-sign-in',
      key: 'share-sign-in:gcloud',
      items: ['s1'],
      label: null,
    });
    expect(
      planNotices([gcloud], kinds, [
        {
          kind: 'share-sign-in',
          key: 'share-sign-in:aws',
          items: ['s2'],
          label: null,
        },
      ]),
    ).toEqual([
      { op: 'resolve', id: 'n1' },
      {
        op: 'open',
        reading: {
          kind: 'share-sign-in',
          key: 'share-sign-in:aws',
          items: ['s2'],
          label: null,
        },
      },
    ]);
  });
});
