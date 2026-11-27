import type { SettingsNoticeKind } from '../../agents/chat.types';

export interface NoticeReading {
  kind: SettingsNoticeKind;
  key: string;
  items: readonly string[];
}

/**
 * TWIN PARSER: the card keys of `SettingsNoticeCard` in
 * `apps/ui/src/renderer/chats/settings-attention-cards.tsx`.
 *
 * The notice a reported item belongs to: the Geniro update is one notice whose
 * version moves on in place, each CLI's update one notice per CLI, each
 * signed-out account one notice of its own.
 */
export function readingsByKey(
  kind: SettingsNoticeKind,
  items: readonly string[],
): NoticeReading[] {
  const keyOf = (item: string): string => {
    if (kind === 'agent-updates') {
      const at = item.lastIndexOf('@');
      return `${kind}:${at === -1 ? item : item.slice(0, at)}`;
    }
    return kind === 'agent-sign-in' ? `${kind}:${item}` : kind;
  };
  const byKey = new Map<string, string[]>();
  for (const item of items) {
    const key = keyOf(item);
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  return [...byKey].map(([key, keyed]) => ({ kind, key, items: keyed }));
}

export interface OpenNotice {
  id: string;
  kind: SettingsNoticeKind;
  key: string;
  items: readonly string[];
  dismissed: boolean;
}

export type NoticeStep =
  | { op: 'open'; reading: NoticeReading }
  | { op: 'resolve'; id: string }
  | { op: 'widen'; id: string; items: string[] };

/**
 * What a reading of `kinds` does to the open notices. A key read with no items
 * resolves its notice. A key with no open notice opens one. An item the open
 * notice never showed widens it, or — once it was dismissed — resolves it and
 * opens a new one, so a dismissed notice comes back only as a new notice.
 */
export function planNotices(
  open: readonly OpenNotice[],
  kinds: ReadonlySet<SettingsNoticeKind>,
  readings: readonly NoticeReading[],
): NoticeStep[] {
  const read = new Map<string, NoticeReading>();
  for (const reading of readings) {
    if (kinds.has(reading.kind) && reading.items.length > 0) {
      read.set(reading.key, reading);
    }
  }
  const steps: NoticeStep[] = [];
  const openByKey = new Map<string, OpenNotice>();
  for (const notice of open) {
    if (!kinds.has(notice.kind)) {
      continue;
    }
    if (read.has(notice.key) && !openByKey.has(notice.key)) {
      openByKey.set(notice.key, notice);
    } else {
      steps.push({ op: 'resolve', id: notice.id });
    }
  }
  for (const reading of read.values()) {
    const notice = openByKey.get(reading.key);
    if (notice === undefined) {
      steps.push({ op: 'open', reading });
      continue;
    }
    const shown = new Set(notice.items);
    const fresh = reading.items.filter((item) => !shown.has(item));
    if (fresh.length === 0) {
      continue;
    }
    if (notice.dismissed) {
      steps.push({ op: 'resolve', id: notice.id }, { op: 'open', reading });
    } else {
      steps.push({
        op: 'widen',
        id: notice.id,
        items: [...notice.items, ...fresh],
      });
    }
  }
  return steps;
}
