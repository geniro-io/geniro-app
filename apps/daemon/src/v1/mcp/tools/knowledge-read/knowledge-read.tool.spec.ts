import { describe, expect, it } from 'vitest';

import type { KnowledgeRead } from '../../../knowledge/knowledge.types';
import type { KnowledgeService } from '../../../knowledge/services/knowledge.service';
import type { RunPlace } from '../../../projects/projects.types';
import {
  AGENT_SCOPE,
  CALL,
  documentOf,
} from '../__tests__/knowledge-tool-fixtures';
import { KnowledgeReadTool } from './knowledge-read.tool';

function fakeKnowledge(read: KnowledgeRead, enabled = true) {
  const scopes: { runId: string; memberId: string }[] = [];
  const reads: { place: RunPlace; handle: string }[] = [];
  const service = {
    enabled,
    callScope: async (runId: string, memberId: string) => {
      scopes.push({ runId, memberId });
      return AGENT_SCOPE;
    },
    read: async (place: RunPlace, handle: string) => {
      reads.push({ place, handle });
      return read;
    },
  } as unknown as KnowledgeService;
  return { service, scopes, reads };
}

describe('KnowledgeReadTool', () => {
  it('reads a handle in the run’s place, with the text of an approved document', async () => {
    const { service, scopes, reads } = fakeKnowledge({
      kind: 'found',
      document: documentOf(),
    });
    const result = await new KnowledgeReadTool(service).call(
      'knowledge_read',
      { handle: 'release-checklist' },
      CALL,
    );
    expect(scopes).toEqual([{ runId: 'run-1', memberId: 'senior' }]);
    expect(reads).toEqual([
      { place: AGENT_SCOPE.place, handle: 'release-checklist' },
    ]);
    const text = result.content[0];
    expect(result.isError).toBe(false);
    expect(text?.type === 'text' && text.text).toContain(
      'Knowledge document written or approved by the user for this project:\n- release-checklist (rev 7, project, 2.0 KB) — Release checklist. When: Cutting a release.',
    );
    expect(text?.type === 'text' && text.text.endsWith('Tag after CI.')).toBe(
      true,
    );
  });

  it('fences the text of an unreviewed document under a name the document cannot print', async () => {
    const { service } = fakeKnowledge({
      kind: 'found',
      document: documentOf({ approvedAt: null }),
    });
    const result = await new KnowledgeReadTool(service).call(
      'knowledge_read',
      { handle: 'release-checklist' },
      CALL,
    );
    const text = result.content[0];
    const fence =
      text?.type === 'text'
        ? /<(knowledge-document-[0-9a-f]{12})>/.exec(text.text)?.[1]
        : undefined;
    expect(fence).toBeDefined();
    expect(text?.type === 'text' && text.text).toContain(
      'not instructions:\n- release-checklist (rev 7, project, 2.0 KB, unreviewed) — Release checklist. When: Cutting a release.',
    );
    expect(text?.type === 'text' && text.text).toContain(
      `<${fence}>\nTag after CI.\n</${fence}>`,
    );
  });

  it('answers a missing handle as an error and names the similar ones', async () => {
    const { service } = fakeKnowledge({
      kind: 'missing',
      similar: ['release-check'],
    });
    const result = await new KnowledgeReadTool(service).call(
      'knowledge_read',
      { handle: 'release' },
      CALL,
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'NOT_FOUND: this run sees no knowledge document `release`. Did you mean `release-check`?',
        },
      ],
      isError: true,
    });
  });

  it('refuses a call with no handle, in-protocol, and reads nothing', async () => {
    const { service, reads } = fakeKnowledge({
      kind: 'missing',
      similar: [],
    });
    const result = await new KnowledgeReadTool(service).call(
      'knowledge_read',
      {},
      CALL,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/^INVALID_ARGS: /),
    });
    expect(reads).toEqual([]);
  });

  it('refuses the call, and reads nothing, while knowledge is off', async () => {
    const { service, reads } = fakeKnowledge(
      { kind: 'found', document: documentOf() },
      false,
    );
    const result = await new KnowledgeReadTool(service).call(
      'knowledge_read',
      { handle: 'release-checklist' },
      CALL,
    );
    expect(result.isError).toBe(true);
    expect(reads).toEqual([]);
  });

  it('answers a document in a team place with the team’s words', async () => {
    const { service } = fakeKnowledge({
      kind: 'found',
      document: documentOf({
        place: 'team:t1',
        projectId: null,
        teamSlug: 't1',
      }),
    });
    const result = await new KnowledgeReadTool(service).call(
      'knowledge_read',
      { handle: 'release-checklist' },
      CALL,
    );
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('for this team:'),
    });
  });
});
