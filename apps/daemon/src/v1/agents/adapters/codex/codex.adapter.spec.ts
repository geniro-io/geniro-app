import type { execFile, spawn } from 'node:child_process';

import { describe, expect, it, onTestFinished } from 'vitest';

import { clearSecrets, redactSecrets } from '../../../diagnostics/utils/redact';
import { MAX_ANSWER_LENGTH } from '../../chat.types';
import type { AgentVersionService } from '../../services/agent-version.service';
import type { ProcessRegistry } from '../../services/process-registry';
import { deliverApprovalAnswer } from '../../utils/approval-answer';
import { fakeGroupChild } from '../__tests__/fake-group-child';
import type {
  AgentEvent,
  AgentSession,
  AgentTurnInput,
  TurnDriver,
} from '../adapter.types';
import { CodexAdapter, type CodexAdapterOptions } from './codex.adapter';
import { CODEX_SESSION_SEARCH_PAGE } from './codex.const';

const THREAD = '01a0e3aa-7dc4-7703-8a60-497958241fd1';

/** The protected turn hooks, reached the way the base reaches them. */
class ProbedCodexAdapter extends CodexAdapter {
  args(input: AgentTurnInput): string[] {
    return this.buildArgs(input);
  }
  env(input: AgentTurnInput): Record<string, string> {
    return this.buildEnv(input);
  }
  driver(input: AgentTurnInput): TurnDriver {
    return this.createTurnDriver(input);
  }
}

const versions = {
  resolve: () => Promise.resolve('0.157.1'),
} as unknown as AgentVersionService;

/** stdout of a one-shot app-server whose request answered `result`. */
function answered(result: unknown): string {
  return `{"id":1,"result":{"userAgent":"codex"}}\n${JSON.stringify({ id: 2, result })}\n`;
}

/**
 * A group spawn that answers each one-shot with `stdout` — given a list, the
 * n-th spawn gets the n-th entry and the last one repeats — recording each.
 */
function oneshotSpawn(stdout: string | readonly string[]): {
  groupSpawnFn: typeof spawn;
  calls: {
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    stdin: string[];
    stdinEnded: () => boolean;
  }[];
} {
  const calls: {
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    stdin: string[];
    stdinEnded: () => boolean;
  }[] = [];
  const replies = typeof stdout === 'string' ? [stdout] : stdout;
  const groupSpawnFn = ((
    _command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    const fake = fakeGroupChild(4242);
    const reply = replies[Math.min(calls.length, replies.length - 1)]!;
    calls.push({
      args,
      env: options.env ?? {},
      stdin: fake.stdinChunks,
      stdinEnded: () => fake.child.stdin?.writableEnded === true,
    });
    queueMicrotask(() => {
      fake.writeStdout(reply);
      fake.close(0);
    });
    return fake.child;
  }) as unknown as typeof spawn;
  return { groupSpawnFn, calls };
}

function adapterWith(
  options: Partial<CodexAdapterOptions> = {},
): ProbedCodexAdapter {
  return new ProbedCodexAdapter({
    versions,
    clientVersion: '1.0.0',
    ...options,
  });
}

function sentMethods(stdin: string[]): string[] {
  return stdin
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { method: string }).method);
}

/** The params of the one frame a one-shot sent for `method`. */
function paramsSentFor(stdin: string[], method: string): unknown {
  const frame = stdin
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; params?: unknown })
    .find((candidate) => candidate.method === method);
  expect(frame).toBeDefined();
  return frame?.params;
}

describe('CodexAdapter config', () => {
  const config = adapterWith().getConfig();

  it('withholds codex’s credentials and account home from every other agent', () => {
    expect(config.auth.isolatedEnvKeys).toEqual(
      expect.arrayContaining(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME']),
    );
    // Only a credential the user exported comes back — never the home, which
    // is the run's own config directory's to decide.
    expect(config.auth.inheritedEnvKeys).toContain('OPENAI_API_KEY');
    expect(config.auth.inheritedEnvKeys).not.toContain('CODEX_HOME');
  });

  it('recognises codex’s own usage-limit wording and when it resets', () => {
    const adapter = adapterWith();
    expect(
      adapter.failureFrom(
        "You've hit your usage limit. Upgrade to Pro or try again at 6:10 PM.",
      ),
    ).toEqual({ class: 'rate_limited', resetsAt: '6:10 PM' });
    expect(
      adapter.errorRecovery(
        'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
      ),
    ).toBe('cli-login');
  });
});

describe('the turn', () => {
  it('spawns the app-server, with the compaction threshold as the one flag', () => {
    const adapter = adapterWith();
    expect(adapter.args({ prompt: 'x', cwd: '/repo' })).toEqual(['app-server']);
    expect(
      adapter.args({
        prompt: 'x',
        cwd: '/repo',
        autoCompact: { percent: 80, windowTokens: 258_400 },
      }),
    ).toEqual(['app-server', '-c', 'model_auto_compact_token_limit=206720']);
  });

  it('points codex at the run’s config directory', () => {
    const adapter = adapterWith();
    expect(
      adapter.env({
        prompt: 'x',
        cwd: '/repo',
        configDir: '/Users/x/.codex-work',
      }),
    ).toMatchObject({ CODEX_HOME: '/Users/x/.codex-work' });
  });

  it('adds geniro’s MCP endpoint beside the user’s servers, token in a header', () => {
    const adapter = adapterWith();
    const driver = adapter.driver({
      prompt: 'x',
      cwd: '/repo',
      mcpEndpoint: {
        url: 'http://127.0.0.1:47615/v1/mcp/run/node',
        token: 'call-token',
        serverName: 'geniro-0123abcd',
      },
    });
    const written: string[] = [];
    driver.onStdinReady?.({
      write: (payload) => {
        written.push(payload);
        return true;
      },
      emit: () => undefined,
    });
    const start = written
      .map(
        (line) =>
          JSON.parse(line) as {
            method?: string;
            params?: Record<string, unknown>;
          },
      )
      .find((frame) => frame.method === 'thread/start');
    expect(start?.params?.config).toEqual({
      'mcp_servers.geniro-0123abcd': {
        url: 'http://127.0.0.1:47615/v1/mcp/run/node',
        http_headers: { Authorization: 'Bearer call-token' },
        tool_timeout_sec: 86_400,
      },
    });
  });

  it('tells the agent about the call tools only when they are registered', () => {
    const instructionsFor = (input: AgentTurnInput): string => {
      const written: string[] = [];
      adapterWith()
        .driver(input)
        .onStdinReady?.({
          write: (payload) => {
            written.push(payload);
            return true;
          },
          emit: () => undefined,
        });
      const start = written
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: { developerInstructions?: string };
            },
        )
        .find((frame) => frame.method === 'thread/start');
      return start?.params?.developerInstructions ?? '';
    };
    const input: AgentTurnInput = {
      prompt: 'x',
      cwd: '/repo',
      systemPrompt: 'ROLE: review the parser',
      callSurfacePrompt: 'MAY CALL: researcher',
    };
    const granted = instructionsFor({
      ...input,
      mcpEndpoint: {
        url: 'http://127.0.0.1:47615/v1/mcp/run/node',
        token: 'call-token',
        serverName: 'geniro-0123abcd',
      },
    });
    expect(granted).toContain('ROLE: review the parser');
    expect(granted).toContain('MAY CALL: researcher');
    const withheld = instructionsFor(input);
    expect(withheld).toContain('ROLE: review the parser');
    expect(withheld).not.toContain('MAY CALL: researcher');
  });

  it('hands a conversation to the terminal as `codex -m <model> resume <id>`', () => {
    const adapter = adapterWith();
    expect(
      adapter.handoffTarget({
        sessionId: THREAD,
        model: 'gpt-5.5',
        configDir: '/Users/x/.codex-work',
      }),
    ).toEqual({
      ok: true,
      kind: 'command',
      command: 'codex',
      args: ['-m', 'gpt-5.5', 'resume', THREAD],
      env: { CODEX_HOME: '/Users/x/.codex-work' },
    });
    expect(
      adapter.handoffTarget({ sessionId: 'not-a-thread', model: null }),
    ).toEqual({ ok: false, reason: 'no-session' });
  });

  it('hands over a COPY while geniro’s own process still holds the thread', () => {
    // codex lets one process hold a thread: a terminal's `resume` would be
    // refused while the kept app-server has it, and `fork` is not.
    expect(
      adapterWith().handoffTarget({
        sessionId: THREAD,
        model: 'gpt-5.5',
        held: true,
      }),
    ).toMatchObject({ ok: true, args: ['-m', 'gpt-5.5', 'fork', THREAD] });
  });
});

describe('listings', () => {
  const MODELS = {
    data: [
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'high' },
        ],
      },
    ],
  };

  it('lists models from a one-shot model/list under the run’s profile', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(answered(MODELS));
    const adapter = adapterWith({ groupSpawnFn });
    await expect(
      adapter.listModels({ configDir: '/Users/x/.codex-work' }),
    ).resolves.toEqual([{ id: 'gpt-5.5', label: 'GPT-5.5', source: 'cli' }]);
    expect(calls[0]?.args).toEqual(['app-server']);
    expect(calls[0]?.env.CODEX_HOME).toBe('/Users/x/.codex-work');
    expect(sentMethods(calls[0]!.stdin)).toEqual([
      'initialize',
      'initialized',
      'model/list',
    ]);
  });

  it('narrows the efforts to what one model accepts, and asks codex once', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(answered(MODELS));
    const adapter = adapterWith({ groupSpawnFn });
    await expect(adapter.listModelEfforts('gpt-5.5')).resolves.toEqual({
      efforts: [
        { id: 'low', label: 'low' },
        { id: 'high', label: 'high' },
      ],
      unavailableReason: null,
      exact: true,
    });
    const superset = await adapter.listModelEfforts('unknown-model');
    expect(superset.exact).toBe(false);
    expect(superset.efforts.map((effort) => effort.id)).toContain('ultra');
    expect(calls).toHaveLength(1);
  });

  it('does not cache an empty model list, so the next listing asks codex again', async () => {
    // An empty answer is a failure to ask, not "this account has no models".
    const { groupSpawnFn, calls } = oneshotSpawn([
      answered({ data: [] }),
      answered(MODELS),
    ]);
    const adapter = adapterWith({ groupSpawnFn });
    await expect(adapter.listModels({ configDir: null })).resolves.toEqual([]);
    await expect(adapter.listModels({ configDir: null })).resolves.toEqual([
      { id: 'gpt-5.5', label: 'GPT-5.5', source: 'cli' },
    ]);
    expect(calls).toHaveLength(2);
  });

  it('lists the skills codex reports, leaving out one that is switched off', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(
      answered({
        data: [
          {
            cwd: '/somewhere',
            skills: [
              { name: 'review', description: 'Review a diff', enabled: true },
              { name: 'deploy', description: 'Ship it', enabled: false },
              { name: 'lint' },
              { description: 'has no name' },
            ],
          },
        ],
      }),
    );
    await expect(
      adapterWith({ groupSpawnFn }).listReportedCommands(),
    ).resolves.toEqual([
      { name: 'review', description: 'Review a diff' },
      { name: 'lint', description: null },
    ]);
    expect(sentMethods(calls[0]!.stdin)).toContain('skills/list');
  });

  it('reads a wider page when searching, matches locally, and says when more exist than were read', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(
      answered({
        data: [
          { id: 'a', name: 'Fix the parser', cwd: '/repo', updatedAt: 10 },
          { id: 'b', name: 'Write docs', cwd: '/repo', updatedAt: 9 },
        ],
        nextCursor: 'more',
      }),
    );
    const listing = await adapterWith({ groupSpawnFn }).listSessions({
      cwd: '/repo',
      configDir: null,
      limit: 20,
      query: 'parser',
    });
    expect(listing.sessions.map((session) => session.id)).toEqual(['a']);
    // The query is matched here rather than by codex, so the page it is matched
    // over is wider than the rows returned.
    expect(paramsSentFor(calls[0]!.stdin, 'thread/list')).toEqual({
      limit: CODEX_SESSION_SEARCH_PAGE,
      cwd: '/repo',
    });
    expect(listing.partialReason).toBe(
      `only the ${CODEX_SESSION_SEARCH_PAGE} most recent conversations were read`,
    );
  });

  it('reads only the rows asked for when it is not searching', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(
      answered({
        data: [
          { id: 'a', name: 'Fix the parser', cwd: '/repo', updatedAt: 10 },
        ],
        nextCursor: 'more',
      }),
    );
    const listing = await adapterWith({ groupSpawnFn }).listSessions({
      cwd: '/repo',
      configDir: null,
      limit: 20,
      query: null,
    });
    expect(paramsSentFor(calls[0]!.stdin, 'thread/list')).toEqual({
      limit: 20,
      cwd: '/repo',
    });
    expect(listing.partialReason).toBe(
      'only the 20 most recent conversations were read',
    );
  });

  it('lists MCP servers from codex’s own configuration', async () => {
    let asked: readonly string[] = [];
    const execFileFn = ((
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      asked = args;
      callback(
        null,
        JSON.stringify([
          {
            name: 'fs',
            enabled: true,
            transport: { type: 'stdio', command: 'npx' },
          },
        ]),
        '',
      );
      return { pid: 1 };
    }) as unknown as typeof execFile;
    await expect(
      adapterWith({ execFileFn }).listMcpServers({ cwd: '/repo' }),
    ).resolves.toEqual({
      ok: true,
      servers: [
        {
          name: 'fs',
          target: 'npx',
          transport: 'stdio',
          status: 'unknown',
          detail: null,
        },
      ],
    });
    expect(asked).toEqual(['mcp', 'list', '--json']);
  });
});

describe('switching an MCP server', () => {
  it('asks codex to write its own config', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(
      answered({
        status: 'ok',
        version: 'v2',
        filePath: '/Users/x/.codex/config.toml',
      }),
    );
    await adapterWith({ groupSpawnFn }).setMcpServerEnabled(
      '/repo',
      'linear',
      false,
      { configDir: '/Users/x/.codex-work' },
    );
    // The switch is per PROFILE: written anywhere but the profile the panel
    // listed, it would edit another account's config and change nothing here.
    expect(calls[0]?.env.CODEX_HOME).toBe('/Users/x/.codex-work');
    const request = calls[0]!.stdin
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: unknown })
      .find((frame) => frame.method === 'config/value/write');
    expect(request?.params).toEqual({
      keyPath: 'mcp_servers.linear.enabled',
      value: false,
      mergeStrategy: 'upsert',
    });
  });

  it('surfaces codex’s refusal instead of reporting success', async () => {
    const { groupSpawnFn } = oneshotSpawn(
      '{"id":1,"result":{}}\n{"id":2,"error":{"code":-32600,"message":"config is read-only"}}\n',
    );
    await expect(
      adapterWith({ groupSpawnFn }).setMcpServerEnabled(
        '/repo',
        'linear',
        true,
      ),
    ).rejects.toThrow('config is read-only');
  });

  it('refuses a name its config key could not address, before spawning', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn(answered({}));
    await expect(
      adapterWith({ groupSpawnFn }).setMcpServerEnabled('/repo', 'a.b', true),
    ).rejects.toThrow('ambiguous');
    expect(calls).toHaveLength(0);
  });

  it('registers its app-server for shutdown, like every other one-shot', async () => {
    // Handed no `onSpawn`, the switch's own child must still be reapable.
    const { groupSpawnFn } = oneshotSpawn(answered({ status: 'ok' }));
    const registered: string[] = [];
    const processes = {
      register: (key: string) => void registered.push(key),
    } as unknown as ProcessRegistry;
    await adapterWith({ groupSpawnFn, processes }).setMcpServerEnabled(
      '/repo',
      'linear',
      true,
    );
    expect(registered).toEqual([expect.stringMatching(/^codex-app-server:/)]);
  });
});

describe('plan limits', () => {
  it('are asked of the running process, whose answer is the run’s own account', async () => {
    const adapter = adapterWith();
    await expect(
      adapter.readPlanLimits({ live: null, sessionId: THREAD }),
    ).resolves.toBeNull();
    let asked: { line: string; read: (obj: unknown) => unknown } | null = null;
    const live = {
      ask: (request: { line: string; read: (obj: unknown) => unknown }) => {
        asked = request;
        const { id } = JSON.parse(request.line) as { id: string };
        return Promise.resolve(
          request.read({
            id,
            result: {
              rateLimits: {
                primary: {
                  usedPercent: 12,
                  windowDurationMins: 300,
                  resetsAt: null,
                },
                planType: 'plus',
              },
            },
          }),
        );
      },
    } as unknown as AgentSession;
    const limits = await adapter.readPlanLimits({ live, sessionId: THREAD });
    expect(asked).not.toBeNull();
    expect(limits).toEqual({
      plan: 'plus',
      windows: [
        { key: 'primary', label: '5-hour limit', percent: 12, resetsAt: null },
      ],
    });
  });
});

describe('naming a chat', () => {
  it('asks a throwaway `codex exec` turn and registers it for shutdown', async () => {
    const { groupSpawnFn, calls } = oneshotSpawn('Refactor the parser\n');
    const registered: string[] = [];
    const processes = {
      register: (key: string) => void registered.push(key),
    } as unknown as ProcessRegistry;
    const title = await adapterWith({ groupSpawnFn, processes }).generateTitle({
      opening: 'Please refactor parser.ts',
      reply: null,
      latest: null,
      configDir: '/Users/x/.codex-work',
    });
    expect(title).toBe('Refactor the parser');
    expect(calls[0]?.args.slice(0, 3)).toEqual([
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
    ]);
    // The user's own config.toml — their MCP servers, their default model —
    // stays out of a turn that only names the chat; the login still applies.
    expect(calls[0]?.args).toContain('--ignore-user-config');
    expect(calls[0]?.env.CODEX_HOME).toBe('/Users/x/.codex-work');
    // `codex exec` reads stdin to EOF even with its prompt in argv.
    expect(calls[0]?.stdinEnded()).toBe(true);
    // The title service hands no `onSpawn`; the adapter still registers the
    // child, since a turn it starts on its own must be reapable.
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatch(/^codex-exec:/);
  });
});

describe('questions', () => {
  it('carries the card’s answer into the reply', () => {
    const adapter = adapterWith();
    const params = {
      questions: [
        { id: 'q1', question: 'Which DB?', options: [{ label: 'SQLite' }] },
      ],
    };
    expect(adapter.questionFrom(params)).toEqual({
      text: 'Which DB?',
      options: ['SQLite'],
    });
    const driver = adapter.driver({
      prompt: 'x',
      cwd: '/repo',
      approvalMode: 'plan',
    });
    const events: AgentEvent[] = [];
    driver.onStdinReady?.({
      write: () => true,
      emit: (event) => events.push(event),
    });
    events.push(
      ...driver.onMessage({
        id: 9,
        method: 'item/tool/requestUserInput',
        params,
      }),
    );
    const reply = driver.buildApprovalResponse?.(
      'n:9',
      true,
      adapter.withAnswer(params, 'SQLite'),
    );
    expect(JSON.parse(reply!)).toMatchObject({
      id: 9,
      result: { answers: { q1: { answers: ['SQLite'] } } },
    });
  });

  /**
   * Answer a two-question codex card whose second question is secret, and
   * return the reply frame as the debug log records it at the moment of the
   * write.
   */
  function answerSecretCard(answer: string): {
    frame: string;
    record: { answer?: string };
  } {
    const adapter = adapterWith();
    const params = {
      questions: [
        { id: 'region', question: 'Which region?', options: [] },
        { id: 'token', question: 'Your token?', isSecret: true, options: [] },
      ],
    };
    const driver = adapter.driver({
      prompt: 'x',
      cwd: '/repo',
      approvalMode: 'plan',
    });
    const events: AgentEvent[] = [];
    driver.onStdinReady?.({
      write: () => true,
      emit: (event) => events.push(event),
    });
    events.push(
      ...driver.onMessage({
        id: 9,
        method: 'item/tool/requestUserInput',
        params,
      }),
    );
    const request = events.find(
      (event): event is Extract<AgentEvent, { type: 'approval_request' }> =>
        event.type === 'approval_request',
    );
    if (request === undefined) {
      throw new Error('codex raised no question card');
    }
    let frame = '';
    const { record } = deliverApprovalAnswer(
      adapter,
      request,
      true,
      answer,
      (input) => {
        frame = redactSecrets(
          driver.buildApprovalResponse?.(request.id, true, input) ?? '',
        );
        return true;
      },
    );
    return { frame, record };
  }

  it('keeps a secret out of the debug log in the frame that answers codex', () => {
    // The stdio channel records the reply FRAME, where each question carries
    // its own value JSON-escaped — the secret may survive there in no spelling.
    onTestFinished(clearSecrets);

    const { frame, record } = answerSecretCard(
      'Which region?: eu-west\nYour token?: tok"en-0123456789',
    );

    expect(record).toEqual({});
    expect(frame).toContain('secret answer redacted');
    expect(frame).not.toContain('0123456789');
    // …and the token alone, when the agent repeats it in a later line.
    expect(
      redactSecrets(JSON.stringify({ command: 'echo tok"en-0123456789' })),
    ).not.toContain('0123456789');
  });

  it('masks a short secret in the slot codex receives it in, and nowhere after', () => {
    onTestFinished(clearSecrets);

    const { frame } = answerSecretCard(
      'Which region?: eu-west\nYour token?: 4821',
    );

    expect(frame).toContain('"token":{"answers":["‹secret answer redacted›"]}');
    expect(redactSecrets('item seq=4821')).toBe('item seq=4821');
  });

  it('offers a calling agent exactly what the question card shows', () => {
    // One reading of the payload: the header the card shows reaches the
    // caller, and a label the card drops — longer than the answer channel
    // carries — is not offered to it either.
    expect(
      adapterWith().questionFrom({
        questions: [
          {
            id: 'q1',
            header: 'Database',
            question: 'Which database should the service use?',
            options: [
              { label: 'SQLite' },
              { label: 'x'.repeat(MAX_ANSWER_LENGTH + 1) },
            ],
          },
        ],
      }),
    ).toEqual({
      text: '[Database] Which database should the service use?',
      options: ['SQLite'],
    });
  });
});
