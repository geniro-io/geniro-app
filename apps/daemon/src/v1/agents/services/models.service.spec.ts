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
      new AgentAdapterRegistry(claude, cursor),
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
