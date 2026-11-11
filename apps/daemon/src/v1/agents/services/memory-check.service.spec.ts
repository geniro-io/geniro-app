import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import { make, memoryDb } from '../../memory/__tests__/memory-db';
import { MemoryReviewFinding } from '../../memory/entity/memory-review-finding.entity';
import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryActor,
  type MemoryEntry,
} from '../../memory/memory.types';
import { Project } from '../../projects/entity/project.entity';
import type { RunPlace } from '../../projects/projects.types';
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
const AGENT: MemoryActor = {
  kind: 'agent',
  runId: 'run-a',
  agentKind: 'claude',
  model: 'opus',
};
const NONE: RunPlace = { projectId: null, teamSlug: null };

const SHARED = 'Always run pnpm install';
const ANSWER_TOKENS_PER_PAIR = 120;
const PAIR_CHARS = 145;
const PAIRS_LISTED = 45;
const REQUESTS = 3;

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

  async function seed(
    title: string,
    body: string,
    actor: MemoryActor = USER,
    place: RunPlace = NONE,
  ): Promise<MemoryEntry> {
    const outcome = await db.service.save(actor, { title, body }, place);
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

  it('an unquoted finding is not asked again', async () => {
    const { request, pair } = await seedPair();
    const ask = vi.spyOn(claude(), 'askOnce').mockResolvedValue(
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
    expect(await db.findings.candidatePairs()).toEqual([]);
    expect(await db.findings.checkable([pair])).toEqual([]);
    expect(await checks.check(request)).toEqual({
      checked: 0,
      skipped: 1,
      findings: [],
    });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('a finding is asked again and shown again after its text changes, even if dismissed', async () => {
    const { request, first } = await seedPair();
    const ask = vi.spyOn(claude(), 'askOnce').mockResolvedValue(
      answer([
        {
          id: 'p1',
          verdict: 'contradicts',
          quoteA: SHARED,
          quoteB: SHARED,
          reason: 'opposed',
        },
      ]),
    );
    const [found] = (await checks.check(request)).findings;

    expect(await db.findings.dismiss(found!.id)).toBe(true);
    expect(await db.findings.open()).toEqual([]);

    const edited = await db.service.edit(first.id, {
      rev: first.rev,
      title: first.title,
      body: 'Always run pnpm install in the workspace root, updated.',
      type: first.type,
      projectId: first.projectId,
      teamSlug: first.teamSlug,
    });
    expect(edited.kind).toBe('updated');

    const again = await checks.check(request);

    expect(ask).toHaveBeenCalledTimes(2);
    expect(again.findings.map((row) => row.id)).toEqual([found!.id]);
    expect((await db.findings.open()).map((row) => row.id)).toEqual([
      found!.id,
    ]);
    expect(await db.em.fork().count(MemoryReviewFinding)).toBe(1);
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

  it('skips the pairs it may not judge and asks about the rest only', async () => {
    const judged = await seedPair();
    const forgotten = await seed('Colima restarts', 'Restart colima daily.');
    await db.service.setStatus(USER, forgotten.id, 'forgotten');
    db.service.setConfig({
      enabled: true,
      agentWrites: 'pending',
      nativeMemoryOff: false,
    });
    const pending = await seed(
      'Changelog format',
      'Keep one line per change.',
      AGENT,
    );
    db.service.setConfig(DEFAULT_MEMORY_CONFIG);
    const em = db.em.fork();
    em.persist(make(Project, { id: 'p1', name: 'p1', folder: '/repo/p1' }));
    em.persist(make(Project, { id: 'p2', name: 'p2', folder: '/repo/p2' }));
    await em.flush();
    const billing = await seed('Billing rule', 'Use credit notes.', USER, {
      projectId: 'p1',
      teamSlug: null,
    });
    const deploy = await seed('Deploy rule', 'Ship on Fridays.', USER, {
      projectId: 'p2',
      teamSlug: null,
    });
    const self = await seed('Changelog rule', 'Lint the changelog.');
    const ask = vi
      .spyOn(claude(), 'askOnce')
      .mockResolvedValue(answer([{ id: 'p1', verdict: 'unrelated' }]));

    const result = await checks.check({
      agentKind: AgentKind.Claude,
      pairs: [
        { aId: forgotten.id, bId: judged.first.id },
        { aId: pending.id, bId: judged.second.id },
        { aId: billing.id, bId: deploy.id },
        { aId: self.id, bId: self.id },
        { aId: judged.first.id, bId: judged.second.id },
        { aId: judged.second.id, bId: judged.first.id },
      ],
    });

    expect(result).toEqual({ checked: 1, skipped: 5, findings: [] });
    expect(ask).toHaveBeenCalledTimes(1);
    const prompt = ask.mock.calls[0]![0].prompt;
    expect(prompt).toContain('Always run pnpm');
    for (const title of [
      'Colima restarts',
      'Changelog format',
      'Billing rule',
      'Deploy rule',
      'Changelog rule',
    ]) {
      expect(prompt).not.toContain(title);
    }
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

  it('lists the pairs of a dozen entries sharing words, and leaves the cost unknown for a model the catalog does not list', async () => {
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

    expect(priced.pairs).toHaveLength(PAIRS_LISTED);
    expect(priced.costUsd).toBeNull();
    expect(priced.requests).toBe(REQUESTS);
  });

  it('prices the ask at the list rates of a priced model, from its tokens', async () => {
    await seedPair();
    const rates = vi.spyOn(claude(), 'billingRatesOf').mockReturnValue({
      input: 1,
      output: 5,
      cacheRead: null,
      cacheWrite: null,
    });

    const priced = await checks.pairs({
      agentKind: AgentKind.Claude,
      model: 'haiku',
    });

    expect(rates).toHaveBeenCalledWith('haiku');
    expect(priced.pairs).toHaveLength(1);
    expect(priced.inputTokens).toBeGreaterThanOrEqual(
      Math.ceil(PAIR_CHARS / 4),
    );
    expect(priced.inputTokens).toBeLessThan(1000);
    expect(priced.costUsd).toBeCloseTo(
      (priced.inputTokens * 1 + ANSWER_TOKENS_PER_PAIR * 5) / 1_000_000,
      12,
    );
  });
});
