import { describe, expect, it } from 'vitest';

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
});
