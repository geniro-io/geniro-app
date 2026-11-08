import { describe, expect, it } from 'vitest';

import {
  clearSecrets,
  registerSecret,
} from '../../../diagnostics/utils/redact';
import type { KnowledgeSearchResult } from '../../../knowledge/knowledge.types';
import type { KnowledgeService } from '../../../knowledge/services/knowledge.service';
import type { RunPlace } from '../../../projects/projects.types';
import { AGENT_SCOPE, CALL } from '../__tests__/knowledge-tool-fixtures';
import { KnowledgeSearchTool } from './knowledge-search.tool';

const SECRET = 'geniro-test-token-9f3a2b7c';

const RELEASE_HIT = {
  handle: 'release-checklist',
  title: 'Release checklist',
  whenToRead: 'Cutting a release.',
  level: 'project',
  rev: 7,
  bodyBytes: 2048,
  reviewed: true,
} as const;

function fakeKnowledge(result: KnowledgeSearchResult, enabled = true) {
  const scopes: { runId: string; memberId: string }[] = [];
  const searches: {
    place: RunPlace;
    query: string | undefined;
    limit: number;
  }[] = [];
  const service = {
    enabled,
    callScope: async (runId: string, memberId: string) => {
      scopes.push({ runId, memberId });
      return AGENT_SCOPE;
    },
    search: async (
      place: RunPlace,
      query: string | undefined,
      limit: number,
    ) => {
      searches.push({ place, query, limit });
      return result;
    },
  } as unknown as KnowledgeService;
  return { service, scopes, searches };
}

describe('KnowledgeSearchTool', () => {
  it('lists the documents the run’s place sees, as the reader words them', async () => {
    const { service, scopes, searches } = fakeKnowledge({
      hits: [RELEASE_HIT],
      total: 1,
    });
    const result = await new KnowledgeSearchTool(service).call(
      'knowledge_search',
      { query: 'release' },
      CALL,
    );
    expect(scopes).toEqual([{ runId: 'run-1', memberId: 'senior' }]);
    expect(searches).toEqual([
      { place: AGENT_SCOPE.place, query: 'release', limit: 10 },
    ]);
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'Knowledge documents this run sees — 1 document. Unmarked ones were written or approved by the user:\n- release-checklist (rev 7, project, 2.0 KB) — Release checklist. When: Cutting a release.',
        },
      ],
      isError: false,
    });
  });

  it('says so when no document the run sees matches the query', async () => {
    const { service } = fakeKnowledge({ hits: [], total: 0 });
    const result = await new KnowledgeSearchTool(service).call(
      'knowledge_search',
      { query: 'release' },
      CALL,
    );
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'No knowledge document this run sees matches "release".',
      },
    ]);
  });

  it('refuses the call, and reads nothing, while knowledge is off', async () => {
    const { service, scopes, searches } = fakeKnowledge(
      { hits: [RELEASE_HIT], total: 1 },
      false,
    );
    const result = await new KnowledgeSearchTool(service).call(
      'knowledge_search',
      { query: 'release' },
      CALL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'KNOWLEDGE_DISABLED: the user has turned knowledge off; work without it.',
      },
    ]);
    expect(scopes).toEqual([]);
    expect(searches).toEqual([]);
  });

  it('masks a registered secret in what it returns', async () => {
    registerSecret(SECRET, 'test key');
    try {
      const { service } = fakeKnowledge({
        hits: [{ ...RELEASE_HIT, title: `Key ${SECRET}` }],
        total: 1,
      });
      const result = await new KnowledgeSearchTool(service).call(
        'knowledge_search',
        { query: 'key' },
        CALL,
      );
      const text = result.content[0];
      expect(text?.type === 'text' && text.text).toContain(
        '‹test key redacted›',
      );
      expect(JSON.stringify(result)).not.toContain(SECRET);
    } finally {
      clearSecrets();
    }
  });
});
