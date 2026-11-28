import type { SettingsNoticeKind } from '../../agents/chat.types';

export interface NoticeReading {
  kind: SettingsNoticeKind;
  key: string;
  items: readonly string[];
  /** What a storage notice's place is called; null for every other kind. */
  label: string | null;
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
  return [...byKey].map(([key, keyed]) => ({
    kind,
    key,
    items: keyed,
    label: null,
  }));
}

export interface OpenNotice {
  id: string;
  kind: SettingsNoticeKind;
  key: string;
  items: readonly string[];
  label: string | null;
  dismissed: boolean;
}

export type NoticeStep =
  | { op: 'open'; reading: NoticeReading }
  | { op: 'resolve'; id: string }
  | { op: 'update'; id: string; items: string[]; label: string | null };

function sameItems(a: readonly string[], b: readonly string[]): boolean {
  const known = new Set(a);
  return a.length === b.length && b.every((item) => known.has(item));
}

/**
 * What a reading of `kinds` does to the open notices. A key read with no items
 * resolves its notice, unless the key is `unsettled`: a reading not known right
 * now leaves its notice as it is. A key with no open notice opens one. An open
 * notice takes what its key holds now, in place; once it was dismissed it keeps
 * what it showed, and an item it never showed resolves it and opens a new one,
 * so a dismissed notice comes back only as a new notice.
 */
export function planNotices(
  open: readonly OpenNotice[],
  kinds: ReadonlySet<SettingsNoticeKind>,
  readings: readonly NoticeReading[],
  unsettled: ReadonlySet<string> = new Set(),
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
    } else if (!unsettled.has(notice.key)) {
      steps.push({ op: 'resolve', id: notice.id });
    }
  }
  for (const reading of read.values()) {
    const notice = openByKey.get(reading.key);
    if (notice === undefined) {
      steps.push({ op: 'open', reading });
      continue;
    }
    if (notice.dismissed) {
      const shown = new Set(notice.items);
      if (reading.items.some((item) => !shown.has(item))) {
        steps.push({ op: 'resolve', id: notice.id }, { op: 'open', reading });
      }
    } else if (
      !sameItems(notice.items, reading.items) ||
      notice.label !== reading.label
    ) {
      steps.push({
        op: 'update',
        id: notice.id,
        items: [...reading.items],
        label: reading.label,
      });
    }
  }
  return steps;
}
