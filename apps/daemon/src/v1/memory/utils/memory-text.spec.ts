import { describe, expect, it } from 'vitest';

import {
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_PREFACE,
  type MemoryEntry,
} from '../memory.types';
import { memoryIndexText } from './memory-text';

const NOW = new Date('2026-10-28T12:00:00Z');

/** An entry whose index line is `- m<handle> [user] <title> (global)`. */
function entry(handle: number, title: string): MemoryEntry {
  return {
    id: `id-${handle}`,
    handle: `m${handle}`,
    title,
    body: 'x',
    type: 'user',
    projectId: null,
    status: 'active',
    rev: 1,
    source: {
      actor: 'user',
      agentKind: null,
      model: null,
      runId: null,
      importedFrom: null,
    },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    lastUsedAt: null,
    approvedAt: null,
  };
}

const LINE_OVERHEAD = Buffer.byteLength('\n- m10 [user]  (global)');
const PREFACE_BYTES = Buffer.byteLength(MEMORY_INDEX_PREFACE);

/** `count` entries with two-digit handles whose `fit` lines fill the cap with less than a footer's room to spare. */
function filling(count: number, fit: number): MemoryEntry[] {
  const per = Math.floor((MEMORY_INDEX_MAX_BYTES - PREFACE_BYTES) / fit);
  const title = 'x'.repeat(per - LINE_OVERHEAD);
  return Array.from({ length: count }, (_, n) => entry(10 + n, title));
}

describe('memoryIndexText', () => {
  it('gives up a line to make room for the footer when entries are left out', () => {
    const index = memoryIndexText(filling(15, 10), NOW) ?? '';
    const lines = index.split('\n');

    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(
      MEMORY_INDEX_MAX_BYTES,
    );
    expect(lines.slice(1, -1)).toHaveLength(9);
    expect(lines.at(-1)).toBe('(+6 more — memory_search)');
  });

  it('lists the last entry without a footer when every entry fits', () => {
    const index = memoryIndexText(filling(10, 10), NOW) ?? '';
    const lines = index.split('\n');

    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(
      MEMORY_INDEX_MAX_BYTES,
    );
    expect(lines.slice(1)).toHaveLength(10);
    expect(index).not.toContain('more — memory_search');
  });

  it('counts the cap in bytes, so non-Latin titles are cut sooner', () => {
    const titles = Array.from({ length: 40 }, (_, n) =>
      `Заметка ${n} ${'слово '.repeat(10)}`.trim(),
    );

    const index =
      memoryIndexText(
        titles.map((title, n) => entry(10 + n, title)),
        NOW,
      ) ?? '';

    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(
      MEMORY_INDEX_MAX_BYTES,
    );
    expect(index.split('\n').at(-1)).toMatch(
      /^\(\+\d+ more — memory_search\)$/,
    );
  });

  it('is null for no entries', () => {
    expect(memoryIndexText([], NOW)).toBeNull();
  });
});
