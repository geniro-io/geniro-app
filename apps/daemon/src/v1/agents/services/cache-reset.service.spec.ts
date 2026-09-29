import { describe, expect, it, vi } from 'vitest';

import { AgentKind } from '../../runs/runs.types';
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
import type { SkillsService } from './skills.service';

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
  skills: ReturnType<typeof clearable>;
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
  const skills = clearable(256);

  return {
    store,
    models,
    efforts,
    contextWindows,
    modelParameters,
    mcp,
    skills,
    claudeClear,
    cursorClear,
    reset: new CacheResetService(
      new AgentAdapterRegistry([claude, cursor]),
      store as unknown as ModelVocabularyStore,
      models as unknown as ModelsService,
      efforts as unknown as EffortsService,
      contextWindows as unknown as ContextWindowsService,
      modelParameters as unknown as ModelParametersService,
      mcp as unknown as AgentMcpService,
      skills as unknown as SkillsService,
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
    // The `/` command catalog is an ASKED answer too (a probe turn), and was
    // missing from the sweep — so the old list survived a reset for its TTL.
    expect(h.skills.clearCache).toHaveBeenCalledTimes(1);
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
    // Distinct powers of two: 1+2+4+8+16+128+256 from the services, 32+64 from
    // the two adapters. Any single omission yields a different sum, which is what
    // makes this a check on the fan-out rather than on arithmetic. It also
    // fails outright on a Promise, which is the structural half of "this asks
    // no CLI anything" — asking one means awaiting.
    const h = harness();

    expect(h.reset.clearAll()).toEqual({ cleared: 511 });
  });
});

describe('CacheResetService.forgetAgent — an account change', () => {
  /** Every per-agent forgetter, answering a distinct count. */
  function forgetting(count: number): {
    forgetAgent: ReturnType<typeof vi.fn>;
  } {
    return { forgetAgent: vi.fn(() => count) };
  }

  function accountHarness() {
    const claude = new ClaudeAdapter();
    const cursor = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    });
    const claudeForget = vi
      .spyOn(claude, 'forgetAccountCaches')
      .mockReturnValue(64);
    const cursorForget = vi
      .spyOn(cursor, 'forgetAccountCaches')
      .mockReturnValue(128);
    const store = { forget: vi.fn(() => 1) };
    const models = forgetting(2);
    const efforts = forgetting(4);
    const contextWindows = forgetting(8);
    const modelParameters = forgetting(16);
    const skills = forgetting(32);
    const mcp = clearable(1024);
    return {
      store,
      models,
      efforts,
      contextWindows,
      modelParameters,
      skills,
      mcp,
      claudeForget,
      cursorForget,
      reset: new CacheResetService(
        new AgentAdapterRegistry([claude, cursor]),
        store as unknown as ModelVocabularyStore,
        models as unknown as ModelsService,
        efforts as unknown as EffortsService,
        contextWindows as unknown as ContextWindowsService,
        modelParameters as unknown as ModelParametersService,
        mcp as unknown as AgentMcpService,
        skills as unknown as SkillsService,
      ),
    };
  }

  it('forgets that agent in EVERY cache — the in-memory mirrors, not only the store', () => {
    // A sign-in dropped the durable store alone, while every in-memory mirror
    // is consulted FIRST — so the composer went on offering the previous
    // account's models, efforts and windows for the rest of each TTL.
    const h = accountHarness();

    const dropped = h.reset.forgetAgent(AgentKind.Claude);

    for (const cache of [
      h.models,
      h.efforts,
      h.contextWindows,
      h.modelParameters,
      h.skills,
    ]) {
      expect(cache.forgetAgent).toHaveBeenCalledWith(AgentKind.Claude);
    }
    expect(h.store.forget).toHaveBeenCalledWith(AgentKind.Claude);
    // 1+2+4+8+16+32 from the caches, 64 from claude's adapter alone.
    expect(dropped).toBe(127);
  });

  it('asks only THAT agent’s adapter, and leaves the MCP listing alone', () => {
    // A server list is a folder's configuration rather than an account fact,
    // and the other CLI's account did not change at all.
    const h = accountHarness();

    h.reset.forgetAgent(AgentKind.Claude);

    expect(h.claudeForget).toHaveBeenCalledTimes(1);
    expect(h.cursorForget).not.toHaveBeenCalled();
    expect(h.mcp.clearCache).not.toHaveBeenCalled();
  });
});
