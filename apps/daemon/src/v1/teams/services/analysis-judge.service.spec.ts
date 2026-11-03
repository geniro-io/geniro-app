import { describe, expect, it } from 'vitest';

import { freshVocabularyStore } from '../../agents/adapters/__tests__/fresh-vocabulary-store';
import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import { CodexAdapter } from '../../agents/adapters/codex/codex.adapter';
import { CursorAcpAdapter } from '../../agents/adapters/cursor-acp/cursor-acp.adapter';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { member, teamOf } from '../__tests__/team-builders';
import { AnalysisJudgeService } from './analysis-judge.service';
import type { TeamStoreService } from './team-store.service';

const TEAM = teamOf([
  member('lead'),
  { ...member('reviewer'), model: 'opus' },
  { ...member('qa'), agent: 'cursor-agent', model: 'gpt-5.6-sol-high' },
]);

function service(): AnalysisJudgeService {
  return new AnalysisJudgeService(
    {
      get: () => Promise.resolve({ slug: 'dev-team', team: TEAM, hash: 'h' }),
    } as unknown as TeamStoreService,
    new AgentAdapterRegistry([
      new ClaudeAdapter(),
      new CodexAdapter(),
      new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore() }),
    ]),
  );
}

describe('AnalysisJudgeService', () => {
  it("names the members that run the judge's vendor, and the agents of another", async () => {
    expect(await service().check('dev-team', { agent: 'claude' })).toEqual({
      judgeVendor: 'anthropic',
      members: 3,
      sameVendor: ['lead', 'reviewer'],
      alternatives: ['codex'],
    });
    expect(
      await service().check('dev-team', {
        agent: 'cursor-agent',
        model: 'gpt-5.6-sol-xhigh',
      }),
    ).toEqual({
      judgeVendor: 'openai',
      members: 3,
      sameVendor: ['qa'],
      alternatives: ['claude'],
    });
  });

  it('flags nothing for a judge whose vendor is not known', async () => {
    expect(
      await service().check('dev-team', {
        agent: 'cursor-agent',
        model: 'auto',
      }),
    ).toMatchObject({ judgeVendor: null, sameVendor: [] });
  });
});
