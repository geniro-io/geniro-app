import { describe, expect, it } from 'vitest';

import { listAgentSessionsQuerySchema } from '../../dto/skills.dto';
import type { AgentSessionRecord } from '../adapter.types';
import {
  matchSessions,
  searchTerms,
  unmatchedTerms,
} from './session-search.utils';

const session = (
  over: Partial<AgentSessionRecord> = {},
): AgentSessionRecord => ({
  id: 's1',
  cwd: '/work/geniro',
  title: 'Fix the auth redirect loop',
  updatedAt: null,
  snippet: null,
  ...over,
});

describe('searchTerms', () => {
  it('splits on whitespace and lowercases', () => {
    expect(searchTerms('  Auth   Geniro ')).toEqual(['auth', 'geniro']);
  });

  it('reads an absent or blank query as no search at all', () => {
    // Load-bearing rather than tidiness: every adapter branches on the terms
    // being empty to mean "list everything", so a blank box that produced one
    // empty term would match nothing and empty the picker.
    expect(searchTerms(null)).toEqual([]);
    expect(searchTerms('   ')).toEqual([]);
  });

  it('caps the term count rather than letting a query split without limit', () => {
    // The DTO bounds the query's LENGTH, not its term COUNT — a bounded
    // string built entirely of one-character words would otherwise still
    // reach `unmatchedTerms` (and, on the claude path, a per-term file
    // search) with no ceiling on how many terms it carries.
    const manyTerms = Array.from({ length: 80 }, (_, i) => `t${i}`).join(' ');
    const terms = searchTerms(manyTerms);
    // The exact cap, not merely "fewer than we asked for": a bound of 1 would
    // also satisfy that, and would silently break multi-term search, since a
    // session must answer for EVERY term. The cap (50) is sized against the
    // DTO's own 200-char query ceiling — see MAX_SEARCH_TERMS's doc block.
    expect(terms).toHaveLength(50);
    expect(terms[0]).toBe('t0');
    expect(terms.at(-1)).toBe('t49');
  });
});

describe('the query DTO bound', () => {
  it('refuses a query past the length ceiling', () => {
    // The ceiling this pins: a query long enough to be pathological rather
    // than a real pasted search phrase must be rejected before it ever
    // reaches `searchTerms`.
    const tooLong = 'a'.repeat(201);
    const result = listAgentSessionsQuerySchema.safeParse({
      agent: 'claude',
      query: tooLong,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a real pasted search phrase', () => {
    const reasonable = 'auth redirect loop in the updater'.repeat(3);
    expect(reasonable.length).toBeLessThanOrEqual(200);
    const result = listAgentSessionsQuerySchema.safeParse({
      agent: 'claude',
      query: reasonable,
    });
    expect(result.success).toBe(true);
  });
});

describe('unmatchedTerms', () => {
  it('answers with what the row does NOT already account for', () => {
    // The expensive half of a search only needs to look for what is left, and
    // this is what tells it: a query naming a project and a phrase has its
    // project half answered without opening anything.
    expect(unmatchedTerms(['auth', 'geniro', 'asar'], session())).toEqual([
      'asar',
    ]);
  });

  it('matches the FOLDER as well as the title', () => {
    expect(unmatchedTerms(['geniro'], session())).toEqual([]);
  });

  it('tolerates a row the CLI named nothing about', () => {
    expect(
      unmatchedTerms(['anything'], session({ title: null, cwd: null })),
    ).toEqual(['anything']);
  });
});

describe('matchSessions', () => {
  it('keeps only the rows answering every term', () => {
    const rows = [
      session({ id: 'a', title: 'auth redirect', cwd: '/work/geniro' }),
      session({ id: 'b', title: 'auth redirect', cwd: '/work/other' }),
      session({ id: 'c', title: 'billing', cwd: '/work/geniro' }),
    ];

    expect(matchSessions(rows, 'auth geniro').map((row) => row.id)).toEqual([
      'a',
    ]);
  });

  it('returns everything for an empty query', () => {
    const rows = [session({ id: 'a' })];

    expect(matchSessions(rows, '')).toHaveLength(1);
    expect(matchSessions(rows, null)).toHaveLength(1);
  });

  it('matches a row whose own title is not lowercase', () => {
    // The row side lowercases the STATED text before comparing — dropping that
    // would make an uppercase row invisible to a lowercase query, and on the
    // cursor path this shared matcher is the whole filter with no fallback, so
    // such a row would vanish from search entirely rather than merely mis-rank.
    const rows = [
      session({ id: 'shout', title: 'ASAR Bundling', cwd: '/work/other' }),
    ];

    expect(matchSessions(rows, 'asar').map((row) => row.id)).toEqual(['shout']);
  });
});
