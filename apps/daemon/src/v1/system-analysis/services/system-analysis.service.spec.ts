import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import type { ChatService } from '../../agents/services/chat.service';
import type { MemoryService } from '../../memory/services/memory.service';
import type { TeamRecommendationDao } from '../../stats/dao/team-recommendation.dao';
import { SYSTEM_DIGEST_REUSE_MS } from '../system-analysis.types';
import { SystemAnalysisService } from './system-analysis.service';
import { SystemAnalysisEventBus } from './system-analysis-events.bus';
import type { SystemDigestService } from './system-digest.service';

type DigestBuild = Awaited<ReturnType<SystemDigestService['build']>>;

function buildOf(label: string, runIds: string[]): DigestBuild {
  return {
    digest: {
      period: { from: label, to: label, days: 7 },
      totals: {
        threadsWithSignals: runIds.length,
        flags: 0,
        failedToolCalls: 0,
        systemThreads: 0,
      },
      threads: [],
      flags: [],
      goneFlags: [],
    },
    runs: runIds.map((runId) => ({ runId, snapshotSeq: 1, working: false })),
  };
}

describe('SystemAnalysisService — the digest a start reads', () => {
  let build: ReturnType<
    typeof vi.fn<(period: { days: number }) => Promise<DigestBuild>>
  >;
  let createChat: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let deleteChat: ReturnType<typeof vi.fn>;
  let findSystemAnalysis: ReturnType<typeof vi.fn>;
  let service: SystemAnalysisService;
  let builds: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T08:36:00.000Z'));
    builds = 0;
    build = vi.fn((period: { days: number }) => {
      builds += 1;
      return Promise.resolve(
        buildOf(`build-${builds}-${period.days}d`, ['r1']),
      );
    });
    createChat = vi.fn(() => Promise.resolve({ id: 'analysis-1' } as RunWire));
    sendMessage = vi.fn(() => Promise.resolve());
    deleteChat = vi.fn(() => Promise.resolve());
    findSystemAnalysis = vi.fn(() => Promise.resolve(null));
    const chats = {
      createChat,
      sendMessage,
      delete: deleteChat,
      findSystemAnalysis,
    } as unknown as ChatService;
    service = new SystemAnalysisService(
      {} as EntityManager,
      { build } as unknown as SystemDigestService,
      chats,
      {} as TeamRecommendationDao,
      { enabled: false } as MemoryService,
      new SystemAnalysisEventBus(),
      join(tmpdir(), 'geniro-system-analysis-spec'),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const frozenDigest = (): string =>
    (
      createChat.mock.calls[0]?.[0] as {
        analysisSystem: { digest: string };
      }
    ).analysisSystem.digest;

  it('starts from the build the scope read just made for the same period, without folding the period again', async () => {
    await service.scope(7);
    vi.setSystemTime(Date.now() + 30_000);

    await service.start({ agentKind: 'claude', days: 7 });

    expect(build).toHaveBeenCalledTimes(1);
    expect(frozenDigest()).toContain('build-1-7d');
  });

  it('builds afresh once the scope read is older than the reuse window', async () => {
    await service.scope(7);
    vi.setSystemTime(Date.now() + SYSTEM_DIGEST_REUSE_MS);

    await service.start({ agentKind: 'claude', days: 7 });

    expect(build).toHaveBeenCalledTimes(2);
    expect(frozenDigest()).toContain('build-2-7d');
  });

  it('builds afresh for another period length', async () => {
    await service.scope(7);

    await service.start({ agentKind: 'claude', days: 3 });

    expect(build).toHaveBeenCalledTimes(2);
    expect(frozenDigest()).toContain('build-2-3d');
  });

  it('does not hand one build to two starts', async () => {
    await service.scope(7);
    await service.start({ agentKind: 'claude', days: 7 });

    await service.start({ agentKind: 'claude', days: 7 });

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('builds again after a scope read whose build failed', async () => {
    build.mockRejectedValueOnce(new Error('database is locked'));
    await expect(service.scope(7)).rejects.toThrow('database is locked');

    await service.start({ agentKind: 'claude', days: 7 });

    expect(build).toHaveBeenCalledTimes(2);
    expect(createChat).toHaveBeenCalledTimes(1);
  });

  it('keeps only the newest scope read, so a start for an earlier period builds afresh', async () => {
    await service.scope(7);
    await service.scope(3);

    await service.start({ agentKind: 'claude', days: 7 });

    expect(build).toHaveBeenCalledTimes(3);
    expect(frozenDigest()).toContain('build-3-7d');
  });

  it('builds afresh when the scope build it joined fails after the press', async () => {
    let failScope: (error: Error) => void = () => undefined;
    build.mockImplementationOnce(
      () =>
        new Promise<DigestBuild>((_resolve, reject) => {
          failScope = reject;
        }),
    );
    const scope = service.scope(7).catch((error: unknown) => error);

    const started = service.start({ agentKind: 'claude', days: 7 });
    failScope(new Error('database is locked'));

    await expect(started).resolves.toMatchObject({ id: 'analysis-1' });
    expect(await scope).toBeInstanceOf(Error);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('still refuses a start whose reused build pinned no thread', async () => {
    build.mockResolvedValueOnce(buildOf('empty', []));
    await service.scope(7);

    await expect(
      service.start({ agentKind: 'claude', days: 7 }),
    ).rejects.toMatchObject({ code: 'SYSTEM_ANALYSIS_NOTHING' });
    expect(build).toHaveBeenCalledTimes(1);
    expect(createChat).not.toHaveBeenCalled();
  });

  it('answers the run as it reads after the brief was sent, not the copy taken before it', async () => {
    createChat.mockResolvedValueOnce({
      id: 'analysis-1',
      status: 'pending',
    });
    findSystemAnalysis.mockResolvedValueOnce({
      id: 'analysis-1',
      status: 'running',
    });

    const answer = await service.start({ agentKind: 'claude', days: 7 });

    expect(answer).toMatchObject({ id: 'analysis-1', status: 'running' });
    expect(findSystemAnalysis).toHaveBeenCalledWith('analysis-1');
    expect(findSystemAnalysis.mock.invocationCallOrder[0] ?? 0).toBeGreaterThan(
      sendMessage.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('answers the created run when its re-read finds none', async () => {
    createChat.mockResolvedValueOnce({
      id: 'analysis-1',
      status: 'pending',
    });

    await expect(
      service.start({ agentKind: 'claude', days: 7 }),
    ).resolves.toMatchObject({ id: 'analysis-1', status: 'pending' });
  });

  it('deletes the run and throws when its brief does not send', async () => {
    sendMessage.mockRejectedValueOnce(new Error('the brief was refused'));

    await expect(
      service.start({ agentKind: 'claude', days: 7 }),
    ).rejects.toThrow('the brief was refused');
    expect(deleteChat).toHaveBeenCalledWith('analysis-1');
    expect(findSystemAnalysis).not.toHaveBeenCalled();
  });
});
