import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import { memoryDb } from '../../memory/__tests__/memory-db';
import {
  DEFAULT_MEMORY_CONFIG,
  MEMORY_CHECK_PAIRS_MAX,
  type MemoryActor,
  type MemoryEntry,
} from '../../memory/memory.types';
import { AgentKind } from '../../runs/runs.types';
import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CodexAdapter } from '../adapters/codex/codex.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import { MEMORY_NOTES_FRAMING } from '../utils/memory-triage';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import type { AgentVersionService } from './agent-version.service';
import { EffortsService } from './efforts.service';
import { MemoryCheckService } from './memory-check.service';
import { OneShotAskService } from './one-shot-ask.service';
import type { ProcessRegistry } from './process-registry';

const USER: MemoryActor = { kind: 'user' };
const NONE = { projectId: null, teamSlug: null };

const SHARED = 'Always run pnpm install';

const TOPICS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
];

describe('MemoryCheckService', () => {
  let db: Awaited<ReturnType<typeof memoryDb>>;
  let home: string;
  let adapters: Map<AgentKind, AgentAdapter>;
  let checks: MemoryCheckService;

  beforeEach(async () => {
    db = await memoryDb();
    db.service.setConfig(DEFAULT_MEMORY_CONFIG);
    home = mkdtempSync(join(tmpdir(), 'geniro-check-home-'));
    adapters = new Map<AgentKind, AgentAdapter>([
      [AgentKind.Claude, new ClaudeAdapter({ homeDir: home })],
      [AgentKind.Codex, new CodexAdapter({ homeDir: home })],
    ]);
    const registry = {
      all: () => adapters,
      for: (kind: AgentKind) => adapters.get(kind),
    } as unknown as AgentAdapterRegistry;
    checks = new MemoryCheckService(
      db.findings,
      new OneShotAskService(
        registry,
        new EffortsService(
          registry,
          {} as ProcessRegistry,
          {} as AgentVersionService,
        ),
      ),
      registry,
    );
  });

  afterEach(async () => {
    clearSecrets();
    rmSync(home, { recursive: true, force: true });
    await db.orm.close();
  });

  function claude() {
    return adapters.get(AgentKind.Claude)!;
  }

  async function seed(title: string, body: string): Promise<MemoryEntry> {
    const outcome = await db.service.save(USER, { title, body }, NONE);
    if (outcome.kind !== 'created') {
      throw new Error(`expected a created entry, got ${outcome.kind}`);
    }
    return outcome.entry;
  }

  async function seedPair() {
    const first = await seed(
      'Pnpm workspace',
      'Always run pnpm\ninstall in the workspace root.',
    );
    const second = await seed(
      'Workspace install',
      'Always run pnpm install here, and never npm install.',
    );
    return {
      first,
      second,
      pair: { aId: first.id, bId: second.id },
      request: {
        agentKind: AgentKind.Claude,
        pairs: [{ aId: first.id, bId: second.id }],
      },
    };
  }

  function answer(verdicts: object[]): string {
    return JSON.stringify(verdicts);
  }

  it('drops a finding whose quote is not in the entry', async () => {
    const { request } = await seedPair();
    vi.spyOn(claude(), 'askOnce').mockResolvedValue(
      answer([
        {
          id: 'p1',
          verdict: 'contradicts',
          quoteA: SHARED,
          quoteB: 'Delete the lockfile entirely',
          reason: 'opposed',
        },
      ]),
    );

    expect(await checks.check(request)).toEqual({
      checked: 1,
      skipped: 0,
      findings: [],
    });
    expect(await db.findings.open()).toEqual([]);
  });

  it('keeps a finding whose quotes are in both entries, a line break in a quote counted as one space', async () => {
    const { request, first, second } = await seedPair();
    vi.spyOn(claude(), 'askOnce').mockResolvedValue(
      answer([
        {
          id: 'p1',
          verdict: 'contradicts',
          quoteA: 'Always run pnpm\ninstall',
          quoteB: SHARED,
          reason: 'the same rule',
        },
      ]),
    );

    const result = await checks.check(request);

    expect(result).toEqual({
      checked: 1,
      skipped: 0,
      findings: [
        expect.objectContaining({
          kind: 'contradicts',
          quoteA: SHARED,
          quoteB: SHARED,
          reason: 'the same rule',
        }),
      ],
    });
    expect(result.findings.map(({ a, b }) => [a.id, b.id].sort())).toEqual([
      [first.id, second.id].sort(),
    ]);
  });

  it('a pair checked is not asked again until a text changes', async () => {
    const { request, first, pair } = await seedPair();
    vi.spyOn(claude(), 'askOnce').mockResolvedValue(
      answer([{ id: 'p1', verdict: 'unrelated' }]),
    );
    expect(await db.findings.candidatePairs()).toHaveLength(1);

    await checks.check(request);

    expect(await db.findings.candidatePairs()).toEqual([]);
    expect(await db.findings.checkable([pair])).toEqual([]);

    await db.service.edit(first.id, {
      rev: first.rev,
      title: first.title,
      body: 'Always run pnpm install in the workspace root, updated.',
      type: first.type,
      projectId: first.projectId,
      teamSlug: first.teamSlug,
    });

    expect(await db.findings.candidatePairs()).toHaveLength(1);
    expect(await db.findings.checkable([pair])).toHaveLength(1);
  });

  it('stores unrelated as checked and never shows it', async () => {
    const { request } = await seedPair();
    vi.spyOn(claude(), 'askOnce').mockResolvedValue(
      answer([{ id: 'p1', verdict: 'unrelated' }]),
    );

    expect(await checks.check(request)).toEqual({
      checked: 1,
      skipped: 0,
      findings: [],
    });
    expect(await db.findings.open()).toEqual([]);
    expect(await db.findings.candidatePairs()).toEqual([]);
  });

  it('fails the batch on an unreadable answer, storing nothing', async () => {
    const { request, pair } = await seedPair();
    const ask = vi
      .spyOn(claude(), 'askOnce')
      .mockResolvedValueOnce('I would rather not say.');

    await expect(checks.check(request)).rejects.toMatchObject({
      errorCode: 'MEMORY_CHECK_FAILED',
      data: { description: expect.stringContaining('could not be read') },
    });
    expect(await db.findings.open()).toEqual([]);
    expect(await db.findings.checkable([pair])).toHaveLength(1);

    ask.mockResolvedValueOnce(null);

    await expect(checks.check(request)).rejects.toMatchObject({
      errorCode: 'MEMORY_CHECK_FAILED',
      data: { description: expect.stringContaining('did not answer') },
    });
  });

  it('cursor is not offered, and a check asked of it is refused', async () => {
    adapters.set(
      AgentKind.CursorAgent,
      new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore() }),
    );
    const { request } = await seedPair();

    expect((await checks.pairs({})).checkAgents).toEqual([
      AgentKind.Claude,
      AgentKind.Codex,
    ]);
    await expect(
      checks.check({ ...request, agentKind: AgentKind.CursorAgent }),
    ).rejects.toMatchObject({ errorCode: 'MEMORY_CHECK_UNAVAILABLE' });
  });

  it('the prompt opens with the framing, and a secret registered after a note was saved is masked', async () => {
    const first = await seed(
      'Pnpm workspace',
      'Always run pnpm install with sk-live-123456789.',
    );
    const second = await seed(
      'Workspace install',
      'Always run pnpm install here, and never npm install.',
    );
    registerSecret('sk-live-123456789', 'test');
    const ask = vi
      .spyOn(claude(), 'askOnce')
      .mockResolvedValue(answer([{ id: 'p1', verdict: 'unrelated' }]));

    await checks.check({
      agentKind: AgentKind.Claude,
      pairs: [{ aId: first.id, bId: second.id }],
    });

    const prompt = ask.mock.calls[0]![0].prompt;
    expect(prompt.startsWith(MEMORY_NOTES_FRAMING.join('\n'))).toBe(true);
    expect(prompt).not.toContain('sk-live-123456789');
  });

  it('prices a listing from the pairs, and leaves the cost unknown for a model the catalog does not list', async () => {
    for (const topic of TOPICS) {
      await seed(
        `${topic} workspace rule`,
        'Keep the workspace note in order.',
      );
    }

    const priced = await checks.pairs({
      agentKind: AgentKind.Claude,
      model: 'no-such-model',
    });

    expect(priced.pairs.length).toBeGreaterThan(MEMORY_CHECK_PAIRS_MAX);
    expect(priced.costUsd).toBeNull();
    expect(priced.inputTokens).toBeGreaterThan(0);
    expect(priced.requests).toBe(
      Math.ceil(priced.pairs.length / MEMORY_CHECK_PAIRS_MAX),
    );
  });
});
