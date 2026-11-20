import type { Team } from '../teams.types';

/** How much of one changed value a diff quotes. */
const MAX_QUOTED_CHARS = 400;
/** How much unchanged text a quoted excerpt keeps on each side of a change. */
const EXCERPT_CONTEXT_CHARS = 80;

export interface QuotedField {
  field: string;
  before: string;
  after: string;
}

/** One member, block or stage whose definition differs, and which of its fields did. */
export interface ChangedEntry {
  id: string;
  fields: QuotedField[];
}

/**
 * What changed between two teams, by member, instruction block and stage id —
 * structural rather than a text diff of the YAML, which reports a reordered
 * list as a rewrite and says nothing about which member a changed line belongs
 * to. A list whose kept entries moved is a `teamFields` entry quoting each
 * side's order of ids.
 *
 * An added entry is named by id alone, since a proposal carries the whole new
 * team; a removed one quotes every field it held (`after` is `(unset)`), since
 * nothing else carries the old team.
 *
 * TWIN PARSER: `readDiff` / `diffRows` in
 * `apps/ui/src/renderer/chats/team-proposal-payload.ts`, which reads the
 * quoted `before`/`after` values as display text only.
 */
export interface TeamDiff {
  identical: boolean;
  teamFields: QuotedField[];
  addedMembers: string[];
  removedMembers: ChangedEntry[];
  changedMembers: ChangedEntry[];
  addedBlocks: string[];
  removedBlocks: ChangedEntry[];
  changedBlocks: ChangedEntry[];
  addedStages: string[];
  removedStages: ChangedEntry[];
  changedStages: ChangedEntry[];
}

function quote(value: unknown): string {
  const text = value === undefined ? '(unset)' : JSON.stringify(value);
  return text.length <= MAX_QUOTED_CHARS
    ? text
    : `${text.slice(0, MAX_QUOTED_CHARS)}… [+${text.length - MAX_QUOTED_CHARS} chars]`;
}

/**
 * Two versions of a long text, each quoted from just before where they first
 * differ to just after where they last do — a role rewritten in its middle
 * reads as that middle, not as two identical openings. A JSON string, so a
 * reader unquotes it like any short value; `…` marks each cut.
 */
function quoteTextChange(
  before: string,
  after: string,
): { before: string; after: string } {
  let prefix = 0;
  const shorter = Math.min(before.length, after.length);
  while (prefix < shorter && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const start = Math.max(0, prefix - EXCERPT_CONTEXT_CHARS);
  const excerpt = (text: string): string => {
    const end = Math.min(
      text.length,
      text.length - suffix + EXCERPT_CONTEXT_CHARS,
    );
    const cut = text.slice(start, end);
    const body =
      cut.length > MAX_QUOTED_CHARS
        ? `${cut.slice(0, MAX_QUOTED_CHARS)}…`
        : `${cut}${end < text.length ? '…' : ''}`;
    return JSON.stringify(`${start > 0 ? '…' : ''}${body}`);
  };
  return { before: excerpt(before), after: excerpt(after) };
}

function quoteChange(
  before: unknown,
  after: unknown,
): { before: string; after: string } {
  if (
    typeof before === 'string' &&
    typeof after === 'string' &&
    JSON.stringify(before).length + JSON.stringify(after).length >
      2 * MAX_QUOTED_CHARS
  ) {
    return quoteTextChange(before, after);
  }
  return { before: quote(before), after: quote(after) };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function changedFields(
  before: object,
  after: object,
  keys: readonly string[],
): QuotedField[] {
  const was = before as Record<string, unknown>;
  const now = after as Record<string, unknown>;
  return [...new Set(keys)]
    .filter((key) => !same(was[key], now[key]))
    .map((field) => ({ field, ...quoteChange(was[field], now[field]) }));
}

function diffById<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
): { added: string[]; removed: ChangedEntry[]; changed: ChangedEntry[] } {
  const beforeById = new Map(before.map((entry) => [entry.id, entry]));
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  const changed: ChangedEntry[] = [];
  for (const [id, next] of afterById) {
    const previous = beforeById.get(id);
    if (previous === undefined) {
      continue;
    }
    const fields = changedFields(previous, next, [
      ...Object.keys(previous),
      ...Object.keys(next),
    ]);
    if (fields.length > 0) {
      changed.push({ id, fields });
    }
  }
  return {
    added: [...afterById.keys()].filter((id) => !beforeById.has(id)),
    removed: before
      .filter((entry) => !afterById.has(entry.id))
      .map((entry) => ({
        id: entry.id,
        fields: changedFields(
          entry,
          {},
          Object.keys(entry).filter((key) => key !== 'id'),
        ),
      })),
    changed,
  };
}

/** Each side's order of the entries both keep, or null when it did not change. */
function reordered(
  field: string,
  before: readonly { id: string }[],
  after: readonly { id: string }[],
): QuotedField | null {
  const kept = new Set(after.map((entry) => entry.id));
  const was = before.map((entry) => entry.id).filter((id) => kept.has(id));
  const had = new Set(was);
  const now = after.map((entry) => entry.id).filter((id) => had.has(id));
  return was.some((id, index) => now[index] !== id)
    ? { field, ...quoteChange(was, now) }
    : null;
}

const LISTS: readonly string[] = ['members', 'instructionBlocks', 'stages'];

export function diffTeams(before: Team, after: Team): TeamDiff {
  const teamFields = changedFields(
    before,
    after,
    [...Object.keys(before), ...Object.keys(after)].filter(
      (field) => !LISTS.includes(field),
    ),
  );
  const moves = [
    reordered('members', before.members, after.members),
    reordered(
      'instructionBlocks',
      before.instructionBlocks,
      after.instructionBlocks,
    ),
    reordered('stages', before.stages ?? [], after.stages ?? []),
  ];
  for (const moved of moves) {
    if (moved !== null) {
      teamFields.push(moved);
    }
  }
  const members = diffById(before.members, after.members);
  const blocks = diffById(before.instructionBlocks, after.instructionBlocks);
  const stages = diffById(before.stages ?? [], after.stages ?? []);
  const diff = {
    teamFields,
    addedMembers: members.added,
    removedMembers: members.removed,
    changedMembers: members.changed,
    addedBlocks: blocks.added,
    removedBlocks: blocks.removed,
    changedBlocks: blocks.changed,
    addedStages: stages.added,
    removedStages: stages.removed,
    changedStages: stages.changed,
  };
  return {
    identical: Object.values(diff).every((list) => list.length === 0),
    ...diff,
  };
}
