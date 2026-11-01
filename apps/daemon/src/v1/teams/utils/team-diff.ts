import type { Team } from '../teams.types';

/** How much of one changed value a diff quotes. */
const MAX_QUOTED_CHARS = 400;
/** How much unchanged text a quoted excerpt keeps on each side of a change. */
const EXCERPT_CONTEXT_CHARS = 80;

/** One node or stage whose definition differs, and which of its fields did. */
export interface ChangedEntry {
  id: string;
  fields: { field: string; before: string; after: string }[];
}

/**
 * What changed between two teams, by node id, stage id and edge —
 * structural rather than a text diff of the YAML, which reports a reordered
 * list as a rewrite and says nothing about which node a changed line belongs
 * to.
 *
 * TWIN PARSER: `readDiff` / `diffRows` in
 * `apps/ui/src/renderer/chats/team-proposal-payload.ts`, which reads the
 * quoted `before`/`after` values as display text only.
 */
export interface TeamDiff {
  identical: boolean;
  teamFields: string[];
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: ChangedEntry[];
  addedEdges: string[];
  removedEdges: string[];
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

function edgeKey(edge: Team['edges'][number]): string {
  return `${edge.from} → ${edge.to} (${edge.kind})`;
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

/** Whether the stages both sides keep are listed in another order. */
function stagesReordered(
  before: readonly { id: string }[],
  after: readonly { id: string }[],
): boolean {
  const kept = new Set(after.map((stage) => stage.id));
  const was = before.map((stage) => stage.id).filter((id) => kept.has(id));
  const had = new Set(was);
  const now = after.map((stage) => stage.id).filter((id) => had.has(id));
  return was.some((id, index) => now[index] !== id);
}

export function diffTeams(before: Team, after: Team): TeamDiff {
  const teamFields = [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].filter(
    (field) =>
      field !== 'nodes' &&
      field !== 'edges' &&
      field !== 'stages' &&
      !same(
        (before as Record<string, unknown>)[field],
        (after as Record<string, unknown>)[field],
      ),
  );
  if (stagesReordered(before.stages ?? [], after.stages ?? [])) {
    teamFields.push('stages');
  }
  const nodes = diffById(before.nodes, after.nodes);
  const stages = diffById(before.stages ?? [], after.stages ?? []);
  const beforeEdges = new Set(before.edges.map(edgeKey));
  const afterEdges = new Set(after.edges.map(edgeKey));
  const diff = {
    teamFields,
    addedNodes: nodes.added,
    removedNodes: nodes.removed,
    changedNodes: nodes.changed,
    addedEdges: [...afterEdges].filter((edge) => !beforeEdges.has(edge)),
    removedEdges: [...beforeEdges].filter((edge) => !afterEdges.has(edge)),
    addedStages: stages.added,
    removedStages: stages.removed,
    changedStages: stages.changed,
  };
  return {
    identical: Object.values(diff).every((list) => list.length === 0),
    ...diff,
  };
}
