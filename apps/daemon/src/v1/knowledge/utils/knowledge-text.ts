import { HOST_KNOWLEDGE_SEARCH_TOOL } from '../../agents/chat.types';
import { redactSecrets } from '../../diagnostics/utils/redact';
import type { RunPlace } from '../../projects/projects.types';
import {
  KNOWLEDGE_HANDLE_MAX_CHARS,
  KNOWLEDGE_INDEX_MAX_BYTES,
  KNOWLEDGE_INDEX_PREFACE,
  type KnowledgeEdit,
  type KnowledgeHead,
  type KnowledgePlaceLevel,
} from '../knowledge.types';

export const GLOBAL_PLACE_KEY = 'global';

const PROJECT_PREFIX = 'project:';
const TEAM_PREFIX = 'team:';

/** The key a document filed in `place` carries; a project wins when both are set. */
export function placeKeyOf(place: RunPlace): string {
  if (place.projectId !== null) {
    return `${PROJECT_PREFIX}${place.projectId}`;
  }
  return place.teamSlug === null
    ? GLOBAL_PLACE_KEY
    : `${TEAM_PREFIX}${place.teamSlug}`;
}

/** The place a key names, or null for anything else. */
export function placeOfKey(key: string): RunPlace | null {
  if (key === GLOBAL_PLACE_KEY) {
    return { projectId: null, teamSlug: null };
  }
  if (key.startsWith(PROJECT_PREFIX) && key.length > PROJECT_PREFIX.length) {
    return { projectId: key.slice(PROJECT_PREFIX.length), teamSlug: null };
  }
  if (key.startsWith(TEAM_PREFIX) && key.length > TEAM_PREFIX.length) {
    return { projectId: null, teamSlug: key.slice(TEAM_PREFIX.length) };
  }
  return null;
}

/** The places a run reads, nearest first. */
export function placeKeysOf(place: RunPlace): string[] {
  return [
    ...(place.projectId === null
      ? []
      : [`${PROJECT_PREFIX}${place.projectId}`]),
    ...(place.teamSlug === null ? [] : [`${TEAM_PREFIX}${place.teamSlug}`]),
    GLOBAL_PLACE_KEY,
  ];
}

export function levelOfKey(key: string): KnowledgePlaceLevel {
  if (key.startsWith(PROJECT_PREFIX)) {
    return 'project';
  }
  return key.startsWith(TEAM_PREFIX) ? 'team' : 'global';
}

/**
 * The one visibility rule: per handle, the row of the nearest place. Ordered
 * nearest place first, each place most recently read first.
 */
export function nearestOf<T extends KnowledgeHead>(
  heads: readonly T[],
  placeKeys: readonly string[],
): T[] {
  const rank = (head: T) => placeKeys.indexOf(head.placeKey);
  const winners = new Map<string, T>();
  for (const head of heads) {
    const held = winners.get(head.handle);
    if (rank(head) >= 0 && (!held || rank(head) < rank(held))) {
      winners.set(head.handle, head);
    }
  }
  return [...winners.values()].sort(
    (a, b) => rank(a) - rank(b) || readAt(b) - readAt(a),
  );
}

function readAt(head: KnowledgeHead): number {
  return (head.lastReadAt ?? head.updatedAt).getTime();
}

/** A title as a handle; never empty. */
export function handleFromTitle(title: string): string {
  const handle = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N}]+/gu, '-')
    .slice(0, KNOWLEDGE_HANDLE_MAX_CHARS)
    .replace(/^-+|-+$/g, '');
  return handle.length > 0 ? handle : 'document';
}

/** `handle`, or the first of `handle-2`, `handle-3`… that `taken` does not hold. */
export function freeHandle(handle: string, taken: ReadonlySet<string>): string {
  if (!taken.has(handle)) {
    return handle;
  }
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${handle.slice(0, KNOWLEDGE_HANDLE_MAX_CHARS - tail.length)}${tail}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

export type EditsResult =
  { ok: true; body: string } | { ok: false; problems: string[] };

/**
 * Apply find-and-replace edits in order, each `find` unique in the body as it
 * stands; one that is missing or repeated refuses the whole set.
 */
export function applyEdits(
  body: string,
  edits: readonly KnowledgeEdit[],
): EditsResult {
  const problems: string[] = [];
  let next = body;
  edits.forEach((edit, index) => {
    const name = `edit ${index + 1}`;
    if (edit.find.length === 0) {
      problems.push(`${name}: find is empty`);
      return;
    }
    const first = next.indexOf(edit.find);
    if (first === -1) {
      problems.push(`${name}: find is not in the document`);
      return;
    }
    if (next.indexOf(edit.find, first + 1) !== -1) {
      problems.push(`${name}: find appears more than once`);
      return;
    }
    next = `${next.slice(0, first)}${edit.replace}${next.slice(first + edit.find.length)}`;
  });
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, body: next };
}

/** The first line holding an invisible character, or null. */
export function firstHiddenLine(
  body: string,
  hidden: (line: string) => boolean,
): number | null {
  const lines = body.split('\n');
  const index = lines.findIndex(hidden);
  return index === -1 ? null : index + 1;
}

export function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function indexLine(head: KnowledgeHead): string {
  const title = redactSecrets(head.title).replace(/\.+$/, '');
  const when = redactSecrets(head.whenToRead);
  return `- ${head.handle} — ${title}. When: ${when} (${levelOfKey(head.placeKey)}, ${kilobytes(head.bodyBytes)})`;
}

function moreLine(count: number): string {
  return `(+${count} more — ${HOST_KNOWLEDGE_SEARCH_TOOL})`;
}

/**
 * A run's knowledge index, cut on whole lines at `KNOWLEDGE_INDEX_MAX_BYTES`
 * with a footer counting what was left out. Only what the user wrote or
 * approved: an agent's unreviewed document never speaks in a run's
 * instructions. Null when there is nothing to list.
 */
export function knowledgeIndexText(
  heads: readonly KnowledgeHead[],
): string | null {
  const listed = heads.filter((head) => head.approvedAt !== null);
  if (listed.length === 0) {
    return null;
  }
  const lines = [KNOWLEDGE_INDEX_PREFACE];
  const roomForFooter = Buffer.byteLength(`\n${moreLine(listed.length)}`);
  let bytes = Buffer.byteLength(KNOWLEDGE_INDEX_PREFACE);
  for (const head of listed) {
    const line = indexLine(head);
    const next = bytes + Buffer.byteLength(`\n${line}`);
    const last = lines.length === listed.length;
    if (next + (last ? 0 : roomForFooter) > KNOWLEDGE_INDEX_MAX_BYTES) {
      break;
    }
    lines.push(line);
    bytes = next;
  }
  const left = listed.length - (lines.length - 1);
  if (left > 0) {
    lines.push(moreLine(left));
  }
  return lines.join('\n');
}
