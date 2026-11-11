import { createHash } from 'node:crypto';

import { HOST_MEMORY_SEARCH_TOOL } from '../../agents/chat.types';
import {
  chatTextMatchQuery,
  chatTextQueryTerms,
} from '../../agents/utils/chat-text-query';
import { redactSecrets } from '../../diagnostics/utils/redact';
import {
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_PREFACE,
  type MemoryEntry,
} from '../memory.types';

/** Below this share of words in common, two titles are different notes. */
const DUPLICATE_TITLE_OVERLAP = 0.6;

const EXCERPT_CHARS = 160;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A title's distinct words, lowercased, split the way the FTS tokenizer splits. */
export function titleWords(title: string): Set<string> {
  return new Set(chatTextQueryTerms(title).filter((word) => word.length > 1));
}

/**
 * An FTS5 query for entries whose TITLE shares any word with `title`, or null
 * when it has none — the candidate set {@link similarTitles} then narrows.
 */
export function titleCandidatesQuery(title: string): string | null {
  const words = [...titleWords(title)];
  if (words.length === 0) {
    return null;
  }
  const any = chatTextMatchQuery(words.join(' OR '));
  return any === null ? null : `title : (${any})`;
}

/** Whether two titles say the same thing: most of their words in common. */
export function similarTitles(a: string, b: string): boolean {
  const left = titleWords(a);
  const right = titleWords(b);
  if (left.size === 0 || right.size === 0) {
    return false;
  }
  let common = 0;
  for (const word of left) {
    if (right.has(word)) {
      common += 1;
    }
  }
  return common / new Set([...left, ...right]).size >= DUPLICATE_TITLE_OVERLAP;
}

/**
 * A run's memory index: one line per entry, in the order given, cut on whole
 * lines at `MEMORY_INDEX_MAX_BYTES` with a footer counting what was left out —
 * its text (null for no entries) and the ids of the entries that fit.
 */
export function memoryIndexOf(
  entries: MemoryEntry[],
  now: Date,
): { text: string | null; ids: string[] } {
  if (entries.length === 0) {
    return { text: null, ids: [] };
  }
  const lines = [MEMORY_INDEX_PREFACE];
  const ids: string[] = [];
  const roomForFooter = Buffer.byteLength(`\n${moreLine(entries.length)}`);
  let bytes = Buffer.byteLength(MEMORY_INDEX_PREFACE);
  for (const entry of entries) {
    const line = indexLine(entry, now);
    const next = bytes + Buffer.byteLength(`\n${line}`);
    const last = lines.length === entries.length;
    if (next + (last ? 0 : roomForFooter) > MEMORY_INDEX_MAX_BYTES) {
      break;
    }
    lines.push(line);
    ids.push(entry.id);
    bytes = next;
  }
  const left = entries.length - ids.length;
  if (left > 0) {
    lines.push(moreLine(left));
  }
  return { text: lines.join('\n'), ids };
}

/** The handles a stored memory index lists, one `- m12 [type] …` line each. */
export function indexHandlesOf(index: string): string[] {
  return [...index.matchAll(/^- (m\d+) \[/gm)].map((match) => match[1]!);
}

function indexLine(entry: MemoryEntry, now: Date): string {
  const scope =
    entry.teamSlug !== null
      ? 'team'
      : entry.projectId === null
        ? 'global'
        : 'project';
  const used =
    entry.lastUsedAt === null
      ? ''
      : `, used ${usedAgo(new Date(entry.lastUsedAt), now)}`;
  return `- ${entry.handle} [${entry.type}] ${redactSecrets(entry.title)} (${scope}${used})`;
}

function usedAgo(at: Date, now: Date): string {
  const days = Math.floor((now.getTime() - at.getTime()) / DAY_MS);
  return days <= 0 ? 'today' : `${days}d ago`;
}

function moreLine(count: number): string {
  return `(+${count} more — ${HOST_MEMORY_SEARCH_TOOL})`;
}

/** The start of a body on one line, for a search hit. */
export function excerptOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_CHARS
    ? flat
    : `${flat.slice(0, EXCERPT_CHARS - 1)}…`;
}

/** A note's text as the import compares it: trimmed title and body. */
export function importedText(title: string, body: string): string {
  return `${title.trim()}\0${body.trim()}`;
}

/** {@link importedText} as a hash, which outlives the text of a purged entry. */
export function importedTextHash(title: string, body: string): string {
  return createHash('sha256').update(importedText(title, body)).digest('hex');
}
