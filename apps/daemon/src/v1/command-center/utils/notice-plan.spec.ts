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
    dismissed: false,
    ...overrides,
  };
}

describe('readingsByKey', () => {
  it('keeps the Geniro update one notice, and splits CLI updates per CLI and sign-ins per account', () => {
    expect(readingsByKey('app-update', ['2.4.0'])).toEqual([
      { kind: 'app-update', key: 'app-update', items: ['2.4.0'] },
    ]);
    expect(
      readingsByKey('agent-updates', ['claude@2.0.0', 'codex@0.9.0']),
    ).toEqual([
      {
        kind: 'agent-updates',
        key: 'agent-updates:claude',
        items: ['claude@2.0.0'],
      },
      {
        kind: 'agent-updates',
        key: 'agent-updates:codex',
        items: ['codex@0.9.0'],
      },
    ]);
    expect(readingsByKey('agent-sign-in', ['claude:/cfg/work'])).toEqual([
      {
        kind: 'agent-sign-in',
        key: 'agent-sign-in:claude:/cfg/work',
        items: ['claude:/cfg/work'],
      },
    ]);
    expect(readingsByKey('agent-updates', [])).toEqual([]);
  });
});

describe('planNotices', () => {
  it('opens a notice for a key read with items and none open', () => {
    expect(
      planNotices([], UPDATE, [
        { kind: 'app-update', key: 'app-update', items: ['1.4.0'] },
      ]),
    ).toEqual([
      {
        op: 'open',
        reading: { kind: 'app-update', key: 'app-update', items: ['1.4.0'] },
      },
    ]);
  });

  it('does nothing when the open notice already shows every item read', () => {
    expect(
      planNotices([open()], UPDATE, [
        { kind: 'app-update', key: 'app-update', items: ['1.4.0'] },
      ]),
    ).toEqual([]);
  });

  it('resolves an open notice whose key is read with no items or not at all', () => {
    expect(
      planNotices([open()], UPDATE, [
        { kind: 'app-update', key: 'app-update', items: [] },
      ]),
    ).toEqual([{ op: 'resolve', id: 'n1' }]);
    expect(planNotices([open()], UPDATE, [])).toEqual([
      { op: 'resolve', id: 'n1' },
    ]);
  });

  it('leaves the notices of kinds this reading did not cover alone', () => {
    expect(
      planNotices([open()], new Set<SettingsNoticeKind>(['agent-updates']), []),
    ).toEqual([]);
  });

  it('widens an undismissed notice in place with an item it never showed', () => {
    expect(
      planNotices([open()], UPDATE, [
        { kind: 'app-update', key: 'app-update', items: ['1.5.0'] },
      ]),
    ).toEqual([{ op: 'widen', id: 'n1', items: ['1.4.0', '1.5.0'] }]);
  });

  it('replaces a dismissed notice with a new one when a new item appears', () => {
    const reading = {
      kind: 'app-update' as const,
      key: 'app-update',
      items: ['1.5.0'],
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
        { kind: 'app-update', key: 'app-update', items: ['1.4.0'] },
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
        { kind: 'app-update', key: 'app-update', items: ['1.4.0'] },
      ]),
    ).toEqual([{ op: 'resolve', id: 'n2' }]);
  });

  it('keys the notices of one kind apart', () => {
    const kinds = new Set<SettingsNoticeKind>(['share-sign-in']);
    const gcloud = open({
      kind: 'share-sign-in',
      key: 'share-sign-in:gcloud',
      items: ['s1'],
    });
    expect(
      planNotices([gcloud], kinds, [
        { kind: 'share-sign-in', key: 'share-sign-in:aws', items: ['s2'] },
      ]),
    ).toEqual([
      { op: 'resolve', id: 'n1' },
      {
        op: 'open',
        reading: {
          kind: 'share-sign-in',
          key: 'share-sign-in:aws',
          items: ['s2'],
        },
      },
    ]);
  });
});
