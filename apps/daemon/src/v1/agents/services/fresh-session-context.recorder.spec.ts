import { describe, expect, it } from 'vitest';

import type { SessionContextReading } from '../../runs/entity/session-context-reading.entity';
import type {
  AgentContextUsage,
  AgentSession,
} from '../adapters/adapter.types';
import type { SessionContextReadingDao } from '../dao/session-context-reading.dao';
import {
  type FreshSessionContextInput,
  FreshSessionContextRecorder,
} from './fresh-session-context.recorder';

const BREAKDOWN: AgentContextUsage = {
  categories: [{ name: 'System prompt', tokens: 21_495, deferred: false }],
  totalTokens: 84_262,
  maxTokens: 1_000_000,
  model: 'claude-sonnet-5-5',
  autoCompactAtTokens: null,
  autoCompactEnabled: null,
  memoryFiles: [{ path: '/repo/AGENTS.md', kind: 'Project', tokens: 30_919 }],
  servers: [
    { name: 'codegraph', tokens: 2_482, toolCount: 4, loadedToolCount: 1 },
  ],
};

function recorderOver(saved: SessionContextReading[], fail = false) {
  return new FreshSessionContextRecorder({
    save: (row: SessionContextReading) =>
      fail
        ? Promise.reject(new Error('disk full'))
        : (saved.push(row), Promise.resolve()),
  } as unknown as SessionContextReadingDao);
}

function inputOf(
  answer: AgentContextUsage | null | Error,
  asked: unknown[],
  live: AgentSession | null = {} as AgentSession,
): FreshSessionContextInput {
  return {
    adapter: {
      readContextUsage: (read) => {
        asked.push(read);
        return answer instanceof Error
          ? Promise.reject(answer)
          : Promise.resolve(answer);
      },
    },
    live,
    runId: 'run-1',
    memberId: 'manager',
    poolMember: 2,
    sessionId: 'sess-1',
    agent: 'claude',
    model: 'sonnet',
    configDir: '/profiles/a',
  };
}

describe('FreshSessionContextRecorder', () => {
  it('stores what the CLI reports for the session, under its run, member and pool member', async () => {
    const saved: SessionContextReading[] = [];
    const asked: unknown[] = [];
    const live = {} as AgentSession;
    await recorderOver(saved).record(inputOf(BREAKDOWN, asked, live));

    expect(asked).toEqual([
      { live, sessionId: 'sess-1', configDir: '/profiles/a' },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      runId: 'run-1',
      sessionId: 'sess-1',
      memberId: 'manager',
      poolMember: 2,
      agent: 'claude',
      model: 'sonnet',
    });
    expect(JSON.parse(saved[0]!.breakdown)).toEqual(BREAKDOWN);
  });

  it('asks nothing without a live process and stores nothing for no answer', async () => {
    const saved: SessionContextReading[] = [];
    const asked: unknown[] = [];
    await recorderOver(saved).record(inputOf(BREAKDOWN, asked, null));
    await recorderOver(saved).record(inputOf(null, asked));

    expect(asked).toHaveLength(1);
    expect(saved).toEqual([]);
  });

  it('never throws when the CLI or the write fails', async () => {
    const asked: unknown[] = [];
    await expect(
      recorderOver([]).record(inputOf(new Error('closed'), asked)),
    ).resolves.toBeUndefined();
    await expect(
      recorderOver([], true).record(inputOf(BREAKDOWN, asked)),
    ).resolves.toBeUndefined();
  });
});
