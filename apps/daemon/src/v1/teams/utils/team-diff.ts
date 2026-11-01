import type { Team } from '../teams.types';

/** How much of one changed value a diff quotes. */
const MAX_QUOTED_CHARS = 400;
/** How much unchanged text a quoted excerpt keeps on each side of a change. */
const EXCERPT_CONTEXT_CHARS = 80;

/** One member, block or stage whose definition differs, and which of its fields did. */
export interface ChangedEntry {
  id: string;
  fields: { field: string; before: string; after: string }[];
}

/**
 * What changed between two teams, by member, instruction block and stage id —
 * structural rather than a text diff of the YAML, which reports a reordered
 * list as a rewrite and says nothing about which member a changed line belongs
 * to. A list whose kept entries moved is named in `teamFields`.
 *
 * TWIN PARSER: `readDiff` / `diffRows` in
 * `apps/ui/src/renderer/chats/team-proposal-payload.ts`, which reads the
 * quoted `before`/`after` values as display text only.
 */
export interface TeamDiff {
  identical: boolean;
  teamFields: string[];
  addedMembers: string[];
  removedMembers: string[];
  changedMembers: ChangedEntry[];
  addedBlocks: string[];
  removedBlocks: string[];
  changedBlocks: ChangedEntry[];
  addedStages: string[];
  removedStages: string[];
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

function diffById<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
): { added: string[]; removed: string[]; changed: ChangedEntry[] } {
  const beforeById = new Map(before.map((entry) => [entry.id, entry]));
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  const changed: ChangedEntry[] = [];
  for (const [id, next] of afterById) {
    const previous = beforeById.get(id);
    if (previous === undefined) {
      continue;
    }
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    const fields = [...keys]
      .filter(
        (key) =>
          !same(
            (previous as Record<string, unknown>)[key],
            (next as Record<string, unknown>)[key],
          ),
      )
      .map((field) => ({
        field,
        ...quoteChange(
          (previous as Record<string, unknown>)[field],
          (next as Record<string, unknown>)[field],
        ),
      }));
    if (fields.length > 0) {
      changed.push({ id, fields });
    }
  }
  return {
    added: [...afterById.keys()].filter((id) => !beforeById.has(id)),
    removed: [...beforeById.keys()].filter((id) => !afterById.has(id)),
    changed,
  };
}

/** Whether the entries both sides keep are listed in another order. */
function reordered(
  before: readonly { id: string }[],
  after: readonly { id: string }[],
): boolean {
  const kept = new Set(after.map((stage) => stage.id));
  const was = before.map((stage) => stage.id).filter((id) => kept.has(id));
  const had = new Set(was);
  const now = after.map((stage) => stage.id).filter((id) => had.has(id));
  return was.some((id, index) => now[index] !== id);
}

const LISTS = ['members', 'instructionBlocks', 'stages'] as const;

export function diffTeams(before: Team, after: Team): TeamDiff {
  const teamFields = [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].filter(
    (field) =>
      !(LISTS as readonly string[]).includes(field) &&
      !same(
        (before as Record<string, unknown>)[field],
        (after as Record<string, unknown>)[field],
      ),
  );
  for (const list of LISTS) {
    if (reordered(before[list] ?? [], after[list] ?? [])) {
      teamFields.push(list);
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
