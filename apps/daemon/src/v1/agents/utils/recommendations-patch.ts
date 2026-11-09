import type { RecommendationsPatch } from '../chat.types';

type Entry = Record<string, unknown>;

function isEntry(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One list of a kept card with a patch's removals and merges made; what cannot be removed is a problem. */
function patchedList(
  held: unknown,
  key: string,
  noun: string,
  changes: readonly Entry[] | undefined,
  removals: readonly string[] | undefined,
  problems: string[],
): unknown {
  if (changes === undefined && removals === undefined) {
    return held;
  }
  let list: unknown[] = Array.isArray(held) ? [...held] : [];
  const named = (entry: unknown, name: unknown): boolean =>
    isEntry(entry) && entry[key] === name;
  for (const name of removals ?? []) {
    if (!list.some((entry) => named(entry, name))) {
      problems.push(`remove names ${noun} ${name}, which is not on the card`);
    }
    list = list.filter((entry) => !named(entry, name));
  }
  for (const change of changes ?? []) {
    const at = list.findIndex((entry) => named(entry, change[key]));
    if (at < 0) {
      list.push(change);
    } else {
      list[at] = { ...(list[at] as Entry), ...change };
    }
  }
  return list;
}

/**
 * A kept card with a patch made in it, still unchecked, or what the patch
 * itself gets wrong. Lists merge entry by entry, each field sent replacing that
 * field: a refusal names an entry, so its fix is that entry's few fields, never
 * the card's whole text again.
 */
export function patchedCard(
  held: Readonly<Entry>,
  patch: RecommendationsPatch,
): { ok: true; card: Entry } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const card: Entry = {
    ...held,
    ...(patch.summary === undefined ? {} : { summary: patch.summary }),
    hotspots: patchedList(
      held.hotspots,
      'title',
      'hotspot',
      patch.hotspots,
      patch.remove?.hotspots,
      problems,
    ),
    items: patchedList(
      held.items,
      'id',
      'item',
      patch.items,
      patch.remove?.items,
      problems,
    ),
    members: patchedList(
      held.members,
      'member',
      'member',
      patch.members,
      patch.remove?.members,
      problems,
    ),
  };
  if (card.members === undefined) {
    delete card.members;
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, card };
}
