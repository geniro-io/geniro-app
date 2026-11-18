import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentAdapter } from '../adapters/agent-adapter';
import { PRICED_MODEL_RESOLVE_MS, resolvePricedModel } from './priced-model';

const profile = realpathSync(
  mkdtempSync(join(tmpdir(), 'geniro-priced-model-')),
);
afterAll(() => rmSync(profile, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

function adapter(
  resolveModel: (
    model: string | null,
    dir: string | null,
  ) => Promise<string | null>,
  vendor: string | null = 'anthropic',
) {
  const resolve = vi.fn(resolveModel);
  return {
    resolve,
    adapter: {
      modelVendorOf: () => vendor,
      vocabularyProfile: (dir: string | null) => dir,
      resolveModel: resolve,
    } as unknown as AgentAdapter,
  };
}

describe('resolvePricedModel', () => {
  it('asks the CLI what an alias runs as under the account folder', async () => {
    const { adapter: a, resolve } = adapter((model) =>
      Promise.resolve(model === 'opus' ? 'claude-opus-5-5' : model),
    );

    await expect(resolvePricedModel(a, 'opus', profile)).resolves.toBe(
      'claude-opus-5-5',
    );
    expect(resolve).toHaveBeenCalledWith('opus', profile);
  });

  it('keeps the id it was given when the CLI cannot answer', async () => {
    const { adapter: a } = adapter(() => Promise.reject(new Error('probe')));

    await expect(resolvePricedModel(a, 'opus', null)).resolves.toBe('opus');
  });

  it('waits on a slow CLI no longer than its bound', async () => {
    vi.useFakeTimers();
    const { adapter: a } = adapter(() => new Promise(() => {}));

    const answer = resolvePricedModel(a, 'opus', null);
    await vi.advanceTimersByTimeAsync(PRICED_MODEL_RESOLVE_MS);

    await expect(answer).resolves.toBe('opus');
  });

  it('asks nothing for a model of no catalog vendor, or under a folder that is gone', async () => {
    const local = adapter(() => Promise.resolve('never'), null);
    const gone = adapter(() => Promise.resolve('never'));

    await expect(
      resolvePricedModel(local.adapter, 'ollama/qwen3', null),
    ).resolves.toBe('ollama/qwen3');
    await expect(
      resolvePricedModel(gone.adapter, 'opus', join(profile, 'gone')),
    ).resolves.toBe('opus');
    expect(local.resolve).not.toHaveBeenCalled();
    expect(gone.resolve).not.toHaveBeenCalled();
  });
});
