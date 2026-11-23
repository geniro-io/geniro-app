import { describe, expect, it } from 'vitest';

import {
  MEMORY_INDEX_MATCH_TERMS,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_PREFACE,
  type MemoryEntry,
} from '../memory.types';
import {
  indexHandlesOf,
  indexMatchQuery,
  memoryIndexOf,
  relevantFirst,
} from './memory-text';

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
    teamSlug: null,
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
    indexed: true,
    promotedAt: null,
    forgetReason: null,
    purgeAt: null,
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

describe('memoryIndexOf', () => {
  it('gives up a line to make room for the footer when entries are left out', () => {
    const index = memoryIndexOf(filling(15, 10), NOW).text ?? '';
    const lines = index.split('\n');

    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(
      MEMORY_INDEX_MAX_BYTES,
    );
    expect(lines.slice(1, -1)).toHaveLength(9);
    expect(lines.at(-1)).toBe('(+6 more — memory_search)');
  });

  it('lists the last entry without a footer when every entry fits', () => {
    const index = memoryIndexOf(filling(10, 10), NOW).text ?? '';
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
      memoryIndexOf(
        titles.map((title, n) => entry(10 + n, title)),
        NOW,
      ).text ?? '';

    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(
      MEMORY_INDEX_MAX_BYTES,
    );
    expect(index.split('\n').at(-1)).toMatch(
      /^\(\+\d+ more — memory_search\)$/,
    );
  });

  it('labels an entry’s scope as team, project or global', () => {
    const index =
      memoryIndexOf(
        [
          { ...entry(10, 'Team one'), teamSlug: 'a' },
          { ...entry(11, 'Project one'), projectId: 'p1' },
          entry(12, 'Global one'),
        ],
        NOW,
      ).text ?? '';

    expect(index).toContain('- m10 [user] Team one (team)');
    expect(index).toContain('- m11 [user] Project one (project)');
    expect(index).toContain('- m12 [user] Global one (global)');
  });

  it('is null for no entries', () => {
    expect(memoryIndexOf([], NOW)).toEqual({ text: null, ids: [] });
  });

  it('names exactly the entries whose lines fit, in order', () => {
    const entries = filling(15, 10);

    const index = memoryIndexOf(entries, NOW);

    expect(index.ids).toEqual(entries.slice(0, 9).map((e) => e.id));
  });

  it('names every entry when all of them fit', () => {
    const entries = filling(10, 10);

    expect(memoryIndexOf(entries, NOW).ids).toHaveLength(10);
  });
});

describe('indexHandlesOf', () => {
  it('reads back the handles of the lines an index lists, not its footer', () => {
    const entries = filling(15, 10);

    const text = memoryIndexOf(entries, NOW).text ?? '';

    expect(indexHandlesOf(text)).toEqual(
      entries.slice(0, 9).map((e) => e.handle),
    );
  });

  it('ignores a handle inside a title', () => {
    const text =
      memoryIndexOf([entry(10, 'see - m99 [user] note')], NOW).text ?? '';

    expect(indexHandlesOf(text)).toEqual(['m10']);
  });
});

describe('the index cap', () => {
  it('lists every entry that fits in 4 KB, where a 2 KB cap would cut it short', () => {
    const entries = Array.from({ length: 20 }, (_, n) =>
      entry(10 + n, `Note ${n} ${'word '.repeat(20)}end`),
    );

    const index = memoryIndexOf(entries, NOW).text ?? '';

    expect(MEMORY_INDEX_MAX_BYTES).toBe(4096);
    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(4096);
    expect(index).not.toContain('more — memory_search');
    expect(indexHandlesOf(index)).toHaveLength(20);
  });
});

describe('relevantFirst', () => {
  it('lists the matched entries first, best match first, then the rest in their order', () => {
    const eligible = [
      entry(10, 'Alpha'),
      entry(11, 'Beta'),
      entry(12, 'Gamma'),
      entry(13, 'Delta'),
    ];

    const ordered = relevantFirst(eligible, ['id-13', 'id-11'], NOW);

    expect(ordered.map((e) => e.id)).toEqual([
      'id-13',
      'id-11',
      'id-10',
      'id-12',
    ]);
  });

  it('never lists an entry twice, and ignores a matched id that is not eligible', () => {
    const eligible = [entry(10, 'Alpha'), entry(11, 'Beta')];

    const ordered = relevantFirst(eligible, ['id-11', 'id-11', 'id-99'], NOW);

    expect(ordered.map((e) => e.id)).toEqual(['id-11', 'id-10']);
  });

  it('keeps a matched entry past the relevant share in its normal place', () => {
    const long = 'x'.repeat(480);
    const plain = [entry(10, 'Plain one'), entry(11, 'Plain two')];
    const matched = Array.from({ length: 6 }, (_, n) =>
      entry(20 + n, `Match ${long}`),
    );

    const ordered = relevantFirst(
      [...plain, ...matched],
      matched.map((e) => e.id),
      NOW,
    );

    expect(ordered.map((e) => e.id)).toEqual([
      'id-20',
      'id-21',
      'id-22',
      'id-23',
      'id-10',
      'id-11',
      'id-24',
      'id-25',
    ]);
  });
});

describe('indexMatchQuery', () => {
  it('is null for a message with no word of three characters or more', () => {
    expect(indexMatchQuery('')).toBeNull();
    expect(indexMatchQuery('   ')).toBeNull();
    expect(indexMatchQuery('a b')).toBeNull();
    expect(indexMatchQuery('?! -- ..')).toBeNull();
  });

  it('matches any one of the message’s words, each as a prefix', () => {
    expect(indexMatchQuery('Retry backoff')).toBe('"retry"* OR "backoff"*');
  });

  it('takes each distinct word once, whatever its case', () => {
    expect(indexMatchQuery('Retry retry RETRY')).toBe('"retry"*');
  });

  it('takes at most MEMORY_INDEX_MATCH_TERMS words of the message', () => {
    const message = Array.from(
      { length: MEMORY_INDEX_MATCH_TERMS + 8 },
      (_, n) => `topic${n}`,
    ).join(' ');

    expect((indexMatchQuery(message) ?? '').split(' OR ')).toHaveLength(
      MEMORY_INDEX_MATCH_TERMS,
    );
  });
});
