import { describe, expect, it } from 'vitest';

import {
  KNOWLEDGE_SEARCH_DEFAULT,
  type KnowledgeHit,
} from '../../../knowledge/knowledge.types';
import {
  knowledgeSearchResultText,
  readKnowledgeSearchArgs,
} from './knowledge-search.reader';

const HIT: KnowledgeHit = {
  handle: 'commit-format',
  title: 'Commit format',
  whenToRead: 'Writing a commit.',
  level: 'global',
  rev: 2,
  bodyBytes: 716,
  reviewed: true,
};

describe('readKnowledgeSearchArgs', () => {
  it('takes no arguments at all, and defaults the limit', () => {
    expect(readKnowledgeSearchArgs({})).toEqual({
      ok: true,
      query: { limit: KNOWLEDGE_SEARCH_DEFAULT },
    });
  });

  it('refuses a place the model names', () => {
    expect(readKnowledgeSearchArgs({ project: 'p2' }).ok).toBe(false);
  });
});

describe('knowledgeSearchResultText', () => {
  it('lists each hit and never a body', () => {
    expect(knowledgeSearchResultText({ hits: [HIT], total: 1 }, 'commit')).toBe(
      'Knowledge documents this run sees — 1 document. Unmarked ones were written or approved by the user:\n- commit-format (rev 2, global, 0.7 KB) — Commit format. When: Writing a commit.',
    );
  });

  it('says how many were cut', () => {
    expect(
      knowledgeSearchResultText({ hits: [HIT], total: 9 }, undefined),
    ).toContain('Showing 1 of 9.');
  });

  it('marks an unreviewed document', () => {
    expect(
      knowledgeSearchResultText(
        { hits: [{ ...HIT, reviewed: false }], total: 1 },
        undefined,
      ),
    ).toContain('0.7 KB, unreviewed)');
  });

  it('words an empty answer by whether a query was given', () => {
    expect(knowledgeSearchResultText({ hits: [], total: 0 }, 'x')).toBe(
      'No knowledge document this run sees matches "x".',
    );
    expect(knowledgeSearchResultText({ hits: [], total: 0 }, undefined)).toBe(
      'This run sees no knowledge documents.',
    );
  });
});
