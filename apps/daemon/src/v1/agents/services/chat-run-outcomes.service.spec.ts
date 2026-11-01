import type { EntityManager } from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import { ChatRunOutcomesService } from './chat-run-outcomes.service';
import { RunOutcomeHistoryService } from './run-outcome-history.service';

const outcome = (seq: number, acceptance: string) => ({
  seq,
  createdAt: new Date(Date.UTC(2026, 9, 27, 9, seq)),
  payload: JSON.stringify({
    prOwner: 'acme',
    prRepo: 'platform',
    prNumber: 87,
    prUrl: 'https://github.com/acme/platform/pull/87',
    draft: false,
    reviewRounds: 1,
    acceptance,
    questionsAsked: 0,
    teamSlug: 'dev-team',
    nodeId: 'manager',
    conversationId: null,
  }),
});

function build(runExists: boolean): ChatRunOutcomesService {
  const em = { fork: () => em } as unknown as EntityManager;
  const runDao = {
    getById: () => Promise.resolve(runExists ? { id: 'run' } : null),
  } as unknown as RunDao;
  const itemDao = {
    rowsOfKinds: (_runId: string, kinds: readonly string[]) =>
      Promise.resolve(
        kinds.includes('run_outcome')
          ? [outcome(10, 'not_yet'), outcome(90_000, 'accepted')]
          : [],
      ),
  } as unknown as ItemDao;
  const adapters = { all: () => new Map() } as unknown as AgentAdapterRegistry;
  return new ChatRunOutcomesService(
    em,
    runDao,
    new RunOutcomeHistoryService(em, itemDao, adapters),
  );
}

describe('ChatRunOutcomesService', () => {
  it('answers every outcome the run holds, however late, per pull request', async () => {
    const { pullRequests } = await build(true).read('run');

    expect(pullRequests).toHaveLength(1);
    expect(pullRequests[0]?.outcomes.map((entry) => entry.seq)).toEqual([
      90_000, 10,
    ]);
  });

  it('refuses a run that does not exist', async () => {
    await expect(build(false).read('gone')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
