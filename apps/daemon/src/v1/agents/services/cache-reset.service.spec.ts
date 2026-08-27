import { describe, expect, it, vi } from 'vitest';

import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import type { AgentMcpService } from './agent-mcp.service';
import { CacheResetService } from './cache-reset.service';
import type { ContextWindowsService } from './context-windows.service';
import type { EffortsService } from './efforts.service';
import type { ModelParametersService } from './model-parameters.service';
import type { ModelVocabularyStore } from './model-vocabulary.store';
import type { ModelsService } from './models.service';

/**
 * One clearable collaborator, answering a DISTINCT count.
 *
 * Distinct powers of two so the total identifies exactly which contributor went
 * missing — a total alone cannot, which is the whole reason the fan-out needed
 * a test: it is a hand-written sum with no structural guarantee that a new
 * cache joins it, and the count is its only observable. A dropped contributor
 * surfaces as a stale picker for the rest of the TTL with a green suite and a
 * log line still reading `cleared N`.
 */
function clearable(count: number): { clearCache: ReturnType<typeof vi.fn> } {
  return { clearCache: vi.fn(() => count) };
}

function harness(): {
  reset: CacheResetService;
  store: { clear: ReturnType<typeof vi.fn> };
  models: ReturnType<typeof clearable>;
  efforts: ReturnType<typeof clearable>;
  contextWindows: ReturnType<typeof clearable>;
  modelParameters: ReturnType<typeof clearable>;
  mcp: ReturnType<typeof clearable>;
  claudeClear: ReturnType<typeof vi.spyOn>;
  cursorClear: ReturnType<typeof vi.spyOn>;
} {
  const claude = new ClaudeAdapter();
  const cursor = new CursorAcpAdapter({
    vocabularyStore: freshVocabularyStore(),
  });
  const claudeClear = vi.spyOn(claude, 'clearCaches').mockReturnValue(32);
  const cursorClear = vi.spyOn(cursor, 'clearCaches').mockReturnValue(64);

  const store = { clear: vi.fn(() => 1) };
  const models = clearable(2);
  const efforts = clearable(4);
  const contextWindows = clearable(8);
  const modelParameters = clearable(16);
  const mcp = clearable(128);

  return {
    store,
    models,
    efforts,
    contextWindows,
    modelParameters,
    mcp,
    claudeClear,
    cursorClear,
    reset: new CacheResetService(
      new AgentAdapterRegistry(claude, cursor),
      store as unknown as ModelVocabularyStore,
      models as unknown as ModelsService,
      efforts as unknown as EffortsService,
      contextWindows as unknown as ContextWindowsService,
      modelParameters as unknown as ModelParametersService,
      mcp as unknown as AgentMcpService,
    ),
  };
}

describe('CacheResetService', () => {
  it('clears EVERY cache, each asked exactly once', () => {
    // Per-collaborator, not merely the total: the correctness argument for this
    // whole chain is WHICH caches it clears, and a sum can be right for the
    // wrong reasons.
    const h = harness();

    h.reset.clearAll();

    expect(h.store.clear).toHaveBeenCalledTimes(1);
    expect(h.models.clearCache).toHaveBeenCalledTimes(1);
    expect(h.efforts.clearCache).toHaveBeenCalledTimes(1);
    expect(h.contextWindows.clearCache).toHaveBeenCalledTimes(1);
    expect(h.modelParameters.clearCache).toHaveBeenCalledTimes(1);
    expect(h.mcp.clearCache).toHaveBeenCalledTimes(1);
  });

  it('asks EVERY registered adapter, rather than naming a CLI', () => {
    // `.claude/rules/agent-adapters.md` — nothing outside an adapter's own
    // directory branches on which CLI it is. A second ACP adapter must join the
    // sweep by being registered, with no edit here.
    const h = harness();

    h.reset.clearAll();

    expect(h.claudeClear).toHaveBeenCalledTimes(1);
    expect(h.cursorClear).toHaveBeenCalledTimes(1);
  });

  it('reports the total, so a dropped contributor changes the number', () => {
    // Distinct powers of two: 1+2+4+8+16+128 from the services, 32+64 from the
    // two adapters. Any single omission yields a different sum, which is what
    // makes this a check on the fan-out rather than on arithmetic. It also
    // fails outright on a Promise, which is the structural half of "this asks
    // no CLI anything" — asking one means awaiting.
    const h = harness();

    expect(h.reset.clearAll()).toEqual({ cleared: 255 });
  });
});
