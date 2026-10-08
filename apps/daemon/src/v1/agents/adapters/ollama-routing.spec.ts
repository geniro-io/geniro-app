import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeSpawn } from '../__tests__/fake-child';
import { AgentAdapterRegistry } from '../services/agent-adapter.registry';
import { spawnAnswering } from './__tests__/fake-group-child';
import { freshVocabularyStore } from './__tests__/fresh-vocabulary-store';
import type { AgentEvent, AgentTurnInput, TurnDriver } from './adapter.types';
import { ClaudeAdapter } from './claude/claude.adapter';
import { CodexAdapter } from './codex/codex.adapter';
import { CursorAcpAdapter } from './cursor-acp/cursor-acp.adapter';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const INPUT: AgentTurnInput = {
  cwd: '/tmp',
  prompt: 'hello',
  model: 'ollama/coder:latest',
  approvalMode: 'auto',
};

describe('Ollama through the existing agent harnesses', () => {
  it.each([
    {
      kind: 'Claude',
      adapterClass: ClaudeAdapter,
      modelFlag: '--model',
      stdout: JSON.stringify({
        type: 'result',
        result: 'Local title',
        is_error: false,
      }),
      requiredArgs: ['--model', 'coder:latest', '--settings'],
      expectedEnv: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:12000',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: 'ollama',
        CLAUDE_CONFIG_DIR: '/tmp/title-profile',
      },
    },
    {
      kind: 'Codex',
      adapterClass: CodexAdapter,
      modelFlag: '-m',
      stdout: 'Local title',
      requiredArgs: [
        '-m',
        'coder:latest',
        'model_provider="geniro-ollama"',
        'model_providers.geniro-ollama.base_url="http://127.0.0.1:12000/v1"',
      ],
      expectedEnv: {
        OPENAI_API_KEY: '',
        OPENAI_BASE_URL: '',
        CODEX_HOME: '/tmp/title-profile',
      },
    },
  ])(
    'keeps $kind title naming local and refuses a cloud-backed model before launching',
    async ({ adapterClass, modelFlag, stdout, requiredArgs, expectedEnv }) => {
      vi.stubEnv('OLLAMA_HOST', '127.0.0.1:12000');
      const fetcher = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ capabilities: ['completion', 'tools'] }),
          ),
      );
      vi.stubGlobal('fetch', fetcher);
      const invocations: {
        args: readonly string[];
        options: Record<string, unknown>;
      }[] = [];
      const adapter = new adapterClass({
        groupSpawnFn: spawnAnswering(stdout, 999999, (args, options) => {
          invocations.push({ args, options });
        }),
      });
      new AgentAdapterRegistry([adapter]);
      const input = {
        model: INPUT.model,
        opening: 'Inspect local files',
        reply: 'Done',
        latest: null,
        configDir: '/tmp/title-profile',
      };
      await expect(
        adapter.generateTitle(input, {
          env: { ANTHROPIC_API_KEY: 'wrong-key', OPENAI_API_KEY: 'wrong-key' },
        }),
      ).resolves.toBe('Local title');
      expect(invocations).toHaveLength(1);
      expect(invocations[0]!.args).toEqual(
        expect.arrayContaining(requiredArgs),
      );
      expect(
        invocations[0]!.args[invocations[0]!.args.indexOf(modelFlag) + 1],
      ).toBe('coder:latest');
      expect(invocations[0]!.args).not.toContain(INPUT.model);
      expect(invocations[0]!.options.env).toMatchObject(expectedEnv);

      fetcher.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              capabilities: ['completion', 'tools'],
              remote_model: 'cloud-coder',
            }),
          ),
      );
      await expect(adapter.generateTitle(input)).resolves.toBeNull();
      expect(invocations).toHaveLength(1);
    },
  );

  it('routes Claude and its model aliases to loopback despite inherited credentials', async () => {
    vi.stubEnv('OLLAMA_HOST', '127.0.0.1:12000');
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-key');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://cloud.example');
    const { spawn, child, captured } = fakeSpawn();
    const adapter = new ClaudeAdapter({ spawn });
    new AgentAdapterRegistry([adapter]);
    const handle = adapter.start(
      { ...INPUT, env: { ANTHROPIC_API_KEY: 'input-key' } },
      () => undefined,
    );
    expect(captured.args).toContain('coder:latest');
    expect(captured.args).not.toContain(INPUT.model);
    expect(captured.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:12000',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'coder:latest',
      CLAUDE_CODE_SUBAGENT_MODEL: 'coder:latest',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    const settingsAt = captured.args!.indexOf('--settings');
    expect(settingsAt).toBeGreaterThan(-1);
    expect(JSON.parse(captured.args![settingsAt + 1]!)).toEqual({
      env: expect.objectContaining({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:12000',
        ANTHROPIC_API_KEY: '',
      }),
    });
    child.emit('close', 0);
    await handle.done;
  });

  it('selects Codex’s local provider in process config and its thread protocol', async () => {
    vi.stubEnv('OLLAMA_HOST', '127.0.0.1:11434');
    const { spawn, child, captured } = fakeSpawn();
    const adapter = new CodexAdapter({ spawn });
    const handle = adapter.start(INPUT, () => undefined);
    expect(captured.args).toContain('model_provider="geniro-ollama"');
    expect(captured.args).toContain(
      'model_providers.geniro-ollama.base_url="http://127.0.0.1:11434/v1"',
    );
    expect(captured.args).toContain('web_search="disabled"');
    const frames = (): {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    }[] =>
      child.stdin.written
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    const initialize = frames().find((frame) => frame.method === 'initialize')!;
    child.stdout.emitData(
      JSON.stringify({ id: initialize.id, result: {} }) + '\n',
    );
    const start = frames().find((frame) => frame.method === 'thread/start')!;
    expect(start.params).toMatchObject({
      model: 'coder:latest',
      modelProvider: 'geniro-ollama',
    });
    child.stdout.emitData(
      JSON.stringify({
        id: start.id,
        result: { thread: { id: 'local-thread' } },
      }) + '\n',
    );
    expect(
      frames().find((frame) => frame.method === 'turn/start')?.params,
    ).toMatchObject({ model: 'coder:latest', threadId: 'local-thread' });
    child.emit('close', 0);
    await handle.done;
  });

  it('qualifies events emitted by a driver without passing through its mapper', async () => {
    class DriverEventsAdapter extends ClaudeAdapter {
      protected override createTurnDriver(): TurnDriver {
        return {
          onMessage: () => [],
          onStdinReady: (io) => {
            io.emit({ type: 'turn_model', model: 'coder:latest' });
            io.emit({ type: 'cost_progress', costUsd: 7 });
          },
        };
      }
    }
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new DriverEventsAdapter({ spawn }).start(INPUT, (event) =>
      events.push(event),
    );
    expect(events).toContainEqual({
      type: 'turn_model',
      model: 'ollama/coder:latest',
    });
    expect(events).toContainEqual({ type: 'cost_progress', costUsd: 0 });
    child.emit('close', 0);
    await handle.done;
  });

  it('preserves native routing and refuses Cursor local routing before spawning', async () => {
    const { spawn, child, captured } = fakeSpawn();
    const handle = new ClaudeAdapter({ spawn }).start(
      { ...INPUT, model: 'opus' },
      () => undefined,
    );
    expect(captured.args).not.toContain('--settings');
    expect(captured.args).toContain('opus');
    child.emit('close', 0);
    await handle.done;
    const cursor = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(cursor.validateModel(INPUT.model)).rejects.toThrow(
      'does not support offline',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
