import { describe, expect, it, vi } from 'vitest';

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
  documentOf,
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

const NO_ITEMS = { carryOut: () => Promise.reject(new Error('unused')) };

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
    const result = await new KnowledgeSaveTool(
      service,
      ordinaryChat(),
      NO_ITEMS,
    ).call('knowledge_save', { ...NEW_DOCUMENT }, CALL);
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
    const result = await new KnowledgeSaveTool(
      service,
      ordinaryChat(),
      NO_ITEMS,
    ).call('knowledge_save', { ...NEW_DOCUMENT }, CALL);
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
      const result = await new KnowledgeSaveTool(
        service,
        ordinaryChat(),
        NO_ITEMS,
      ).call(
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
    const result = await new KnowledgeSaveTool(
      service,
      ordinaryChat(),
      NO_ITEMS,
    ).call('knowledge_save', { ...NEW_DOCUMENT }, CALL);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: 'KNOWLEDGE_DISABLED: the user has turned knowledge off; work without it.',
    });
    expect(saves).toEqual([]);
  });

  describe('an applied knowledge item', () => {
    const analysisGates = () => {
      const gates = ordinaryChat();
      gates.analysis.register(CALL.runId, CALL.memberId, {
        turn: {
          analysisRunId: CALL.runId,
          sourceRunId: 'source',
          snapshotSeq: 0,
          sourceWorking: false,
        },
        report: () => Promise.reject(new Error('unused')),
        mark: () => Promise.reject(new Error('unused')),
      });
      return gates;
    };
    const saved = {
      kind: 'applied' as const,
      document: documentOf({ handle: 'stand', rev: 1 }),
      created: true,
    };

    it('lists `item`, with nothing else required, only where an analysis turn runs', () => {
      const { service } = fakeKnowledge(saved);
      const listed = (gates: ReturnType<typeof ordinaryChat>) =>
        new KnowledgeSaveTool(service, gates, NO_ITEMS).list(CALL)[0];

      const inAnalysis = listed(analysisGates());
      expect(
        Object.keys(inAnalysis?.inputSchema.properties as object),
      ).toContain('item');
      expect(inAnalysis?.inputSchema.required).toEqual([]);
      expect(inAnalysis?.description).toContain('pass only `item`');

      const elsewhere = listed(ordinaryChat());
      expect(
        Object.keys(elsewhere?.inputSchema.properties as object),
      ).not.toContain('item');
      expect(elsewhere?.description).not.toContain('pass only `item`');
    });

    it('carries out the item, with no text of the model’s, and tells the agent to mark it', async () => {
      const { service, saves } = fakeKnowledge(saved);
      const carryOut = vi.fn(async () => saved);

      const result = await new KnowledgeSaveTool(service, analysisGates(), {
        carryOut,
      }).call('knowledge_save', { item: 'K-1' }, CALL);

      expect(carryOut).toHaveBeenCalledWith(
        expect.objectContaining({ analysisRunId: CALL.runId }),
        AGENT_SCOPE.actor,
        'K-1',
      );
      expect(saves).toEqual([]);
      expect(result.isError).toBe(false);
      expect(result.content[0]).toMatchObject({
        text: 'Saved `stand` at rev 1 for K-1, as the user applied it. Mark K-1 now.',
      });
    });

    it('refuses text beside the item, another target’s id, and an item outside an analysis', async () => {
      const { service, saves } = fakeKnowledge(saved);
      const carryOut = vi.fn(async () => saved);
      const inAnalysis = new KnowledgeSaveTool(service, analysisGates(), {
        carryOut,
      });

      const withText = await inAnalysis.call(
        'knowledge_save',
        { item: 'K-1', body: 'other text' },
        CALL,
      );
      const otherTarget = await inAnalysis.call(
        'knowledge_save',
        { item: 'P-1' },
        CALL,
      );
      const outside = await new KnowledgeSaveTool(service, ordinaryChat(), {
        carryOut,
      }).call('knowledge_save', { item: 'K-1' }, CALL);

      expect(withText.isError).toBe(true);
      expect(otherTarget.isError).toBe(true);
      expect(outside.isError).toBe(true);
      expect(carryOut).not.toHaveBeenCalled();
      expect(saves).toEqual([]);
    });

    it('answers a refusal as an error, with its code', async () => {
      const { service } = fakeKnowledge(saved);

      const result = await new KnowledgeSaveTool(service, analysisGates(), {
        carryOut: async () => ({
          kind: 'item-refused' as const,
          code: 'NOT_SELECTED',
          reason: 'K-1 was not selected',
        }),
      }).call('knowledge_save', { item: 'K-1' }, CALL);

      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        text: 'NOT_SELECTED: K-1 was not selected',
      });
    });
  });
});
