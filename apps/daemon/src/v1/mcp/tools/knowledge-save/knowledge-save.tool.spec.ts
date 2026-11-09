import { describe, expect, it } from 'vitest';

import {
  clearSecrets,
  registerSecret,
} from '../../../diagnostics/utils/redact';
import type {
  KnowledgeActor,
  KnowledgeSaveOutcome,
} from '../../../knowledge/knowledge.types';
import type { KnowledgeService } from '../../../knowledge/services/knowledge.service';
import type { RunPlace } from '../../../projects/projects.types';
import {
  AGENT_SCOPE,
  CALL,
  headOf,
  ordinaryChat,
} from '../__tests__/knowledge-tool-fixtures';
import { KnowledgeSaveTool } from './knowledge-save.tool';

const SECRET = 'geniro-test-token-9f3a2b7c';

const NEW_DOCUMENT = {
  title: 'Release checklist',
  whenToRead: 'Cutting a release.',
  body: 'Tag only after CI is green.',
  reason: 'found it useful',
};

function fakeKnowledge(outcome: KnowledgeSaveOutcome, enabled = true) {
  const saves: { actor: KnowledgeActor; input: unknown; place: RunPlace }[] =
    [];
  const service = {
    enabled,
    agentsMayWrite: enabled,
    callScope: async () => AGENT_SCOPE,
    save: async (actor: KnowledgeActor, input: unknown, place: RunPlace) => {
      saves.push({ actor, input, place });
      return outcome;
    },
  } as unknown as KnowledgeService;
  return { service, saves };
}

describe('KnowledgeSaveTool', () => {
  it('saves as the calling agent, in the run’s place, and says a proposal waits for review', async () => {
    const { service, saves } = fakeKnowledge({
      kind: 'proposed',
      document: headOf({
        handle: 'release-checklist',
        status: 'proposed',
        rev: 0,
        approvedAt: null,
      }),
      created: true,
    });
    const result = await new KnowledgeSaveTool(service, ordinaryChat()).call(
      'knowledge_save',
      { ...NEW_DOCUMENT },
      CALL,
    );
    expect(saves).toEqual([
      {
        actor: AGENT_SCOPE.actor,
        input: NEW_DOCUMENT,
        place: AGENT_SCOPE.place,
      },
    ]);
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: "Proposed a new document `release-checklist`: it waits for the user's review on the Knowledge page. No agent sees it until they approve, and nothing has changed yet.",
        },
      ],
      isError: false,
    });
  });

  it('answers a refusal as an error that names its code and reason', async () => {
    const { service } = fakeKnowledge({
      kind: 'refused',
      code: 'KNOWLEDGE_READ_ONLY',
      reason:
        'the user lets agents read knowledge, not write it — tell the user what should change',
    });
    const result = await new KnowledgeSaveTool(service, ordinaryChat()).call(
      'knowledge_save',
      { ...NEW_DOCUMENT },
      CALL,
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'KNOWLEDGE_READ_ONLY: the user lets agents read knowledge, not write it — tell the user what should change',
        },
      ],
      isError: true,
    });
  });

  it('masks a registered secret that a refusal echoes back', async () => {
    registerSecret(SECRET, 'test key');
    try {
      const { service } = fakeKnowledge({
        kind: 'refused',
        code: 'NOT_FOUND',
        reason: `no document ${SECRET} this run can see — search again`,
      });
      const result = await new KnowledgeSaveTool(service, ordinaryChat()).call(
        'knowledge_save',
        {
          handle: SECRET,
          rev: 1,
          edits: [{ find: 'a', replace: 'b' }],
          reason: 'r',
        },
        CALL,
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('‹test key redacted›');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    } finally {
      clearSecrets();
    }
  });

  it('refuses the call, and saves nothing, while knowledge is off', async () => {
    const { service, saves } = fakeKnowledge(
      { kind: 'refused', code: 'KNOWLEDGE_DISABLED', reason: 'off' },
      false,
    );
    const result = await new KnowledgeSaveTool(service, ordinaryChat()).call(
      'knowledge_save',
      { ...NEW_DOCUMENT },
      CALL,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: 'KNOWLEDGE_DISABLED: the user has turned knowledge off; work without it.',
    });
    expect(saves).toEqual([]);
  });
});
