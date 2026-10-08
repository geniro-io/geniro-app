import { afterEach, describe, expect, it, vi } from 'vitest';

import * as ollama from '../utils/ollama';
import { OllamaService } from './ollama.service';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Ollama discovery', () => {
  it('lists installed local models with availability and excludes cloud models', async () => {
    vi.stubEnv('OLLAMA_HOST', '127.0.0.1:11434');
    const details: Record<string, unknown> = {
      coder: { capabilities: ['completion', 'tools'] },
      embedding: { capabilities: ['embedding'] },
      text: { capabilities: ['completion'] },
      remote: { capabilities: ['completion', 'tools'], remote_model: 'remote' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        const body = url.endsWith('/api/tags')
          ? { models: Object.keys(details).map((name) => ({ name })) }
          : details[JSON.parse(String(options?.body)).model as string];
        return new Response(JSON.stringify(body));
      }),
    );
    expect(await new OllamaService().list()).toEqual([
      { id: 'ollama/coder', label: 'coder', source: 'ollama' },
      {
        id: 'ollama/embedding',
        label: 'embedding',
        source: 'ollama',
        unavailableReason: expect.stringContaining('cannot generate text'),
      },
      {
        id: 'ollama/text',
        label: 'text',
        source: 'ollama',
        unavailableReason: expect.stringContaining('tool calling'),
      },
    ]);
  });

  it('coalesces discovery, then sees newly pulled models after its short cache expires', async () => {
    vi.stubEnv('OLLAMA_HOST', '127.0.0.1:11434');
    vi.useFakeTimers();
    let names = ['first'];
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith('/api/tags')
              ? { models: names.map((name) => ({ name })) }
              : { capabilities: ['completion', 'tools'] },
          ),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const service = new OllamaService();
    const [first, simultaneous] = await Promise.all([
      service.list(),
      service.list(),
    ]);
    expect(first).toEqual(simultaneous);
    expect(fetcher).toHaveBeenCalledTimes(2);
    names = ['second'];
    expect(await service.list()).toEqual(first);
    vi.advanceTimersByTime(5_001);
    expect(await service.list()).toEqual([
      { id: 'ollama/second', label: 'second', source: 'ollama' },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([true, false])(
    'explains why an unreachable installation is unavailable (installed=%s)',
    async (installed) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('connection refused')),
      );
      vi.spyOn(ollama, 'ollamaInstalled').mockReturnValue(installed);
      const rows = await new OllamaService().list();
      expect(rows).toEqual([
        expect.objectContaining({
          id: 'ollama/',
          source: 'ollama',
          label: installed ? 'Ollama is stopped' : 'Ollama is not installed',
          unavailableReason: expect.any(String),
        }),
      ]);
    },
  );

  it('refuses nonlocal configuration without sending a request', async () => {
    vi.stubEnv('OLLAMA_HOST', 'remote.example:11434');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await new OllamaService().list()).toEqual([
      expect.objectContaining({
        unavailableReason: expect.stringContaining('loopback'),
      }),
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
