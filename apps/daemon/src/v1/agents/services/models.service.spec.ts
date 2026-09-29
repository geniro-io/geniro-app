import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import type { AgentModelWire } from '../chat.types';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVersionService } from './agent-version.service';
import { ModelVocabularyStore } from './model-vocabulary.store';
import { ModelsService, type ModelsServiceOptions } from './models.service';
import { ProcessRegistry } from './process-registry';

function service(
  options: ModelsServiceOptions = {},
  store: ModelVocabularyStore = freshVocabularyStore(),
): {
  models: ModelsService;
  cursor: CursorAcpAdapter;
  store: ModelVocabularyStore;
} {
  const claude = new ClaudeAdapter();
  const cursor = new CursorAcpAdapter({ vocabularyStore: store });
  // The version is PINNED, and that is what makes the durable path reachable
  // at all: the binary is absent here, so a real `--version` resolves to null,
  // and the store refuses to serve OR store under a null version — every
  // assertion about it would be vacuously true.
  const versions = new AgentVersionService();
  vi.spyOn(versions, 'resolve').mockResolvedValue('2026.08.11-e8db854');
  return {
    cursor,
    store,
    models: new ModelsService(
      new AgentAdapterRegistry([claude, cursor]),
      new ProcessRegistry(),
      versions,
      store,
      options,
    ),
  };
}

const LISTED: AgentModelWire[] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', source: 'cli' },
];

describe('ModelsService — the memory mirror over the durable store', () => {
  it('seeds the mirror with the READ time, not the stored timestamp', async () => {
    // The defect this pins is silent: the store keeps serving an entry for an
    // hour before it revalidates, while this cache expires it after ten
    // minutes. Seeded with the DISK timestamp, every entry older than the TTL
    // but younger than the revalidate window failed the memory check on EVERY
    // call — so the disk read and its shape walk ran per request instead of
    // once per TTL window, for the whole remaining fifty minutes.
    //
    // The store shares the test's CLOCK, which is load-bearing: with its own
    // real `Date.now` its `fetchedAt` sits in a different epoch from the fake
    // one, `now - fetchedAt` goes hugely negative, and the memory entry reads
    // as fresh whichever timestamp seeded it — so the assertion below would
    // hold with the fix reverted.
    let clock = 0;
    const store = new ModelVocabularyStore({
      file: join(mkdtempSync(join(tmpdir(), 'geniro-models-')), 'v.json'),
      now: () => clock,
    });
    const reads = vi.spyOn(store, 'read');
    const { models, cursor } = service(
      { ttlMs: 10 * 60_000, now: () => clock },
      store,
    );
    const ask = vi
      .spyOn(cursor, 'listModels')
      .mockResolvedValue(structuredClone(LISTED));

    await models.list('cursor-agent');
    expect(ask).toHaveBeenCalledTimes(1);

    // Past the memory TTL, still inside the store's own revalidate window: the
    // store answers and re-seeds the mirror.
    clock = 30 * 60_000;
    await models.list('cursor-agent');
    const afterReseed = reads.mock.calls.length;

    // The very next call must be answered from memory. Seeded from disk it is
    // already expired again, and every call re-reads the store for ever.
    await models.list('cursor-agent');
    await models.list('cursor-agent');

    expect(reads.mock.calls.length).toBe(afterReseed);
  });

  it('asks the CLI once when two callers race a cold list', async () => {
    // Listing cursor's models spawns a process group, so two chat panes
    // mounting their model chip at once must not launch two of them for one
    // account-level answer.
    const { models, cursor } = service();
    const ask = vi
      .spyOn(cursor, 'listModels')
      .mockResolvedValue(structuredClone(LISTED));

    const [a, b] = await Promise.all([
      models.list('cursor-agent'),
      models.list('cursor-agent'),
    ]);

    expect(ask).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });
});

describe('ModelsService — one list per ACCOUNT', () => {
  it("asks per profile, and never serves one account's models to another", async () => {
    // The composer's own reader, and the defect from its end: the memory cache
    // was keyed by AGENT alone, so the first chat to open its picker filed its
    // subscription's models under the CLI's name and every other account was
    // served that. Which models exist is decided by the subscription, and the
    // subscription is the config directory.
    const { models } = service();
    const listed = vi
      .spyOn(ClaudeAdapter.prototype, 'listModels')
      .mockImplementation(({ configDir }) =>
        Promise.resolve([
          {
            id: `model-for-${configDir ?? 'default'}`,
            label: 'Whatever this account offers',
            source: 'cli' as const,
          },
        ]),
      );

    const team = await models.list('claude', '/profiles/team');
    const max = await models.list('claude', '/profiles/max');
    // Served from cache the second time round, so the key SPLITS rather than
    // merely defeating the cache.
    const teamAgain = await models.list('claude', '/profiles/team');

    expect(team.map((m) => m.id)).toEqual(['model-for-/profiles/team']);
    expect(max.map((m) => m.id)).toEqual(['model-for-/profiles/max']);
    expect(teamAgain).toEqual(team);
    expect(listed).toHaveBeenCalledTimes(2);
    listed.mockRestore();
  });
});

describe('ModelsService — an account change (`forgetAgent`)', () => {
  const OLD: AgentModelWire[] = [
    { id: 'old-account-model', label: 'Old', source: 'cli' },
  ];
  const NEW: AgentModelWire[] = [
    { id: 'new-account-model', label: 'New', source: 'cli' },
  ];

  /** A listing the SPEC answers, so an ask can be held open across a forget. */
  function heldListing(cursor: CursorAcpAdapter): {
    answer: (index: number, models: AgentModelWire[]) => void;
    calls: () => number;
  } {
    const pending: ((models: AgentModelWire[]) => void)[] = [];
    vi.spyOn(cursor, 'listModels').mockImplementation(
      () =>
        new Promise<AgentModelWire[]>((resolve) => {
          pending.push(resolve);
        }),
    );
    return {
      answer: (index, models) => pending[index]?.(structuredClone(models)),
      calls: () => pending.length,
    };
  }

  /** Let the listing's own awaits (the version) run until the ask is made. */
  async function untilAsked(calls: () => number, count: number): Promise<void> {
    while (calls() < count) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  it('drops the MEMORY copy, which is read before the store', async () => {
    // A sign-in forgot the durable store alone, and this mirror is consulted
    // FIRST — so the previous account's models were served for the rest of the
    // ten-minute TTL.
    const { models, cursor, store } = service();
    const listing = heldListing(cursor);
    const first = models.list('cursor-agent');
    await untilAsked(listing.calls, 1);
    listing.answer(0, OLD);
    await first;

    // The durable half is dropped as the sign-in always dropped it; what is
    // under test is that the memory half now goes with it.
    store.forget('cursor-agent');
    expect(models.forgetAgent('cursor-agent')).toBe(1);
    const second = models.list('cursor-agent');
    await untilAsked(listing.calls, 2);
    listing.answer(1, NEW);

    expect(await second).toEqual(NEW);
  });

  it('never files an answer whose ask started before the forget', async () => {
    // The race the forget alone cannot close: an ask already running was taken
    // under the credentials just replaced, and landing after the forget it
    // wrote the previous account's list back — into memory AND onto disk.
    const { models, cursor, store } = service();
    const listing = heldListing(cursor);
    const before = models.list('cursor-agent');
    await untilAsked(listing.calls, 1);

    models.forgetAgent('cursor-agent');
    store.forget('cursor-agent');
    const after = models.list('cursor-agent');
    await untilAsked(listing.calls, 2);
    listing.answer(0, OLD);
    await before;
    listing.answer(1, NEW);

    expect(await after).toEqual(NEW);
    // Served from memory now, and it is the NEW account's list.
    expect(await models.list('cursor-agent')).toEqual(NEW);
    expect(listing.calls()).toBe(2);
    expect(
      store.read('cursor-agent', null, null, '2026.08.11-e8db854', isList)
        ?.value,
    ).toEqual(NEW);
  });

  it('never files a BACKGROUND refresh that straddled the forget', async () => {
    // Serve-then-refresh: a stored answer past its revalidate window is served
    // and re-asked behind the response. A sign-in landing while that refresh
    // runs must not have it write the old account's models back for a week.
    let clock = 0;
    const store = new ModelVocabularyStore({
      file: join(mkdtempSync(join(tmpdir(), 'geniro-models-')), 'v.json'),
      now: () => clock,
    });
    store.remember('cursor-agent', null, null, '2026.08.11-e8db854', OLD);
    clock = 2 * 60 * 60_000;
    const { models, cursor } = service({ now: () => clock }, store);
    const listing = heldListing(cursor);

    expect(await models.list('cursor-agent')).toEqual(OLD);
    await untilAsked(listing.calls, 1);
    store.forget('cursor-agent');
    models.forgetAgent('cursor-agent');
    listing.answer(0, OLD);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      store.read('cursor-agent', null, null, '2026.08.11-e8db854', isList),
    ).toBeNull();
  });
});

/** The store's shape guard, in miniature. */
function isList(value: unknown): value is AgentModelWire[] {
  return Array.isArray(value);
}
