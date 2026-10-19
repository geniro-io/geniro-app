import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ollamaBaseUrl,
  ollamaModelName,
  qualifyOllamaEvent,
  validateOllamaModel,
} from './ollama';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('offline Ollama model routing', () => {
  it('preserves native IDs and unwraps local model names', () => {
    expect(ollamaModelName('opus')).toBeNull();
    expect(ollamaModelName(null)).toBeNull();
    expect(ollamaModelName('ollama/qwen3.8:27b')).toBe('qwen3.8:27b');
    expect(() => ollamaModelName('ollama/')).toThrow('installed Ollama');
    expect(() => ollamaModelName('ollama/-model')).toThrow();
    expect(() => ollamaModelName('ollama/model\nother')).toThrow();
  });

  it.each([
    ['localhost', 'http://localhost:11434'],
    ['127.0.0.1:12000', 'http://127.0.0.1:12000'],
    ['0.0.0.0:11434', 'http://127.0.0.1:11434'],
    ['[::]:11434', 'http://[::1]:11434'],
    ['http://localhost:80', 'http://localhost'],
  ])('normalizes local bind address %s', (host, expected) => {
    vi.stubEnv('OLLAMA_HOST', host);
    expect(ollamaBaseUrl()).toBe(expected);
  });

  it.each([
    'https://ollama.com',
    '192.168.1.10:11434',
    'http://localhost@remote.example:11434',
    'http://localhost:11434/api',
    'http://localhost:11434?remote=true',
  ])('refuses a remote or ambiguous endpoint %s before a request', (host) => {
    vi.stubEnv('OLLAMA_HOST', host);
    expect(() => ollamaBaseUrl()).toThrow();
  });

  it('validates local tool support and makes no request for native models', async () => {
    vi.stubEnv('OLLAMA_HOST', '127.0.0.1:11434');
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ capabilities: ['completion', 'tools'] })),
      );
    vi.stubGlobal('fetch', fetcher);
    await validateOllamaModel('opus');
    expect(fetcher).not.toHaveBeenCalled();
    await validateOllamaModel('ollama/qwen3.8:27b');
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/show',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({ model: 'qwen3.8:27b' }),
      }),
    );
  });

  it.each([
    [{ capabilities: ['embedding'] }, 'cannot generate text'],
    [{ capabilities: ['completion'] }, 'tool calling'],
    [
      {
        capabilities: ['completion', 'tools'],
        remote_host: 'https://ollama.com',
      },
      'cloud',
    ],
  ])('rejects unavailable models: %j', async (details, reason) => {
    vi.stubEnv('OLLAMA_HOST', '127.0.0.1:11434');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(details))),
    );
    await expect(validateOllamaModel('ollama/model')).rejects.toThrow(reason);
  });

  it('reports an absent server without falling back to the native provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('connection refused')),
    );
    await expect(validateOllamaModel('ollama/model')).rejects.toThrow(
      'connection refused',
    );
  });

  it('keeps local identity and zero spend in both live and settled events', () => {
    const model = 'ollama/qwen3.8:27b';
    expect(
      qualifyOllamaEvent({ type: 'turn_model', model: 'qwen3.8:27b' }, model),
    ).toEqual({ type: 'turn_model', model });
    expect(
      qualifyOllamaEvent(
        { type: 'cost_progress', costUsd: 4, estimatedCostUsd: 4 },
        model,
      ),
    ).toEqual({ type: 'cost_progress', costUsd: 0 });
    const settled = {
      type: 'turn_complete' as const,
      stopReason: null,
      finalText: null,
      usage: {
        inputTokens: 12,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        thinkingTokens: null,
        contextTokens: null,
        contextWindowTokens: null,
        contextModel: null,
        costUsd: 4,
        durationMs: null,
        apiMs: null,
        ttftMs: null,
        timeToRequestMs: null,
        numTurns: null,
        modelCosts: [{ model: 'claude-sonnet-5-5', costUsd: 4 }],
      },
    };
    // The split of a figure that is now $0 goes with it.
    expect(qualifyOllamaEvent(settled, model)).toEqual({
      type: 'turn_complete',
      stopReason: null,
      finalText: null,
      usage: {
        ...settled.usage,
        costUsd: 0,
        contextModel: model,
        modelCosts: null,
      },
    });
    expect(settled.usage.costUsd).toBe(4);
    expect(qualifyOllamaEvent(settled, 'opus')).toBe(settled);
  });

  it('prices a FAILED or stopped local turn at $0 too, estimate and split dropped', () => {
    const usage = {
      inputTokens: 12,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      contextTokens: null,
      contextWindowTokens: null,
      contextModel: null,
      costUsd: 4,
      estimatedCostUsd: 4,
      durationMs: null,
      apiMs: null,
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
      modelCosts: [{ model: 'claude-sonnet-5-5', costUsd: 4 }],
    };
    for (const event of [
      { type: 'error' as const, message: 'result: is_error', usage },
      { type: 'turn_cancelled' as const, usage },
    ]) {
      const qualified = qualifyOllamaEvent(event, 'ollama/qwen3.8:27b');
      expect(qualified).toMatchObject({
        usage: { costUsd: 0, modelCosts: null },
      });
      expect(
        'usage' in qualified && qualified.usage
          ? 'estimatedCostUsd' in qualified.usage
          : true,
      ).toBe(false);
    }
  });

  it('drops a hosted-price estimate, since a local turn costing $0 is a fact', () => {
    const settled = {
      type: 'turn_complete' as const,
      stopReason: null,
      finalText: null,
      usage: {
        inputTokens: 12,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        thinkingTokens: null,
        contextTokens: null,
        contextWindowTokens: null,
        contextModel: null,
        costUsd: 4,
        estimatedCostUsd: 4,
        durationMs: null,
        apiMs: null,
        ttftMs: null,
        timeToRequestMs: null,
        numTurns: null,
      },
    };
    const qualified = qualifyOllamaEvent(settled, 'ollama/qwen3.8:27b');
    if (qualified.type !== 'turn_complete' || qualified.usage === null) {
      throw new Error('expected a turn_complete carrying usage');
    }
    expect(qualified.usage.costUsd).toBe(0);
    expect('estimatedCostUsd' in qualified.usage).toBe(false);
  });
});
