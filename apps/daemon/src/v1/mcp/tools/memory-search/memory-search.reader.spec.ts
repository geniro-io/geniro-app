import { describe, expect, it } from 'vitest';

import {
  MEMORY_RESULT_PREFACE,
  MEMORY_SEARCH_DEFAULT,
  MEMORY_SEARCH_MAX,
  type MemoryHit,
} from '../../../memory/memory.types';
import {
  memorySearchResultText,
  readMemorySearchArgs,
} from './memory-search.reader';

const HIT: MemoryHit = {
  id: 'id-1',
  handle: 'm1',
  title: 'Daemon binds loopback',
  excerpt: '127.0.0.1 only.',
  type: 'project',
  projectId: null,
  teamSlug: null,
  status: 'active',
  rev: 1,
  source: {
    actor: 'agent',
    agentKind: 'codex',
    model: null,
    runId: 'r1',
    importedFrom: null,
  },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: null,
  approvedAt: null,
  indexed: false,
  promotedAt: null,
  forgetReason: null,
  purgeAt: null,
};

describe('readMemorySearchArgs', () => {
  it('defaults the limit and clamps one past the cap to it', () => {
    expect(readMemorySearchArgs({ query: 'pnpm' })).toEqual({
      ok: true,
      query: { query: 'pnpm', limit: MEMORY_SEARCH_DEFAULT },
    });
    expect(readMemorySearchArgs({ query: 'pnpm', limit: 22 })).toEqual({
      ok: true,
      query: { query: 'pnpm', limit: MEMORY_SEARCH_MAX },
    });
    expect(readMemorySearchArgs({ query: 'x' }).ok).toBe(false);
  });

  it('reads keywords as the query and max_results as the limit', () => {
    expect(readMemorySearchArgs({ keywords: 'pnpm' })).toEqual({
      ok: true,
      query: { query: 'pnpm', limit: MEMORY_SEARCH_DEFAULT },
    });
    expect(readMemorySearchArgs({ keywords: 'pnpm', max_results: 3 })).toEqual({
      ok: true,
      query: { query: 'pnpm', limit: 3 },
    });
  });

  it('leads a refusal with the right call, and refuses query and keywords that disagree', () => {
    const read = readMemorySearchArgs({ query: 'pnpm', keywords: 'npm' });
    expect(!read.ok && read.error.split('\n')).toEqual([
      'call memory_search({query: "<words>", limit: 5}) — at most 10 entries.',
      'send query once — query and keywords name the same argument and disagree',
    ]);
  });
});

describe('memorySearchResultText', () => {
  it('leads the hits with the data-not-instructions line', () => {
    expect(memorySearchResultText('loopback', [HIT])).toBe(
      [
        MEMORY_RESULT_PREFACE,
        '- m1 (rev 1, global, project) — Daemon binds loopback: 127.0.0.1 only.',
        'Read whole entries with memory_read.',
      ].join('\n'),
    );
  });

  it('says plainly when nothing matches', () => {
    expect(memorySearchResultText('zzz', [])).toMatch(
      /^No memory matches "zzz"/,
    );
  });

  it('ends with the note saying search by meaning left memory to words, with or without hits', () => {
    const note =
      'Search by meaning is off for memory in Settings → Search, so only word matches are listed.';

    expect(memorySearchResultText('zzz', [], note).split('\n')).toEqual([
      'No memory matches "zzz". Try other words, or save what you learn with memory_save.',
      note,
    ]);
    expect(
      memorySearchResultText('loopback', [HIT], note).split('\n').at(-1),
    ).toBe(note);
    expect(memorySearchResultText('zzz', [], null)).toBe(
      'No memory matches "zzz". Try other words, or save what you learn with memory_save.',
    );
  });
});
