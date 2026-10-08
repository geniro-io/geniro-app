import { describe, expect, it } from 'vitest';

import {
  CODEX_BUILTIN_SIGN_IN_REASON,
  CODEX_BUILTIN_TOGGLE_REASON,
  CODEX_MCP_STATUS_MAX_PAGES,
  CODEX_PROJECT_TOGGLE_REASON,
} from '../codex.const';
import {
  CodexMcpListing,
  codexMcpRow,
  codexMcpStatus,
  codexMcpToggleRefusal,
  codexTurnMcpOverrides,
  codexTurnToggleReason,
  readCodexMcpConfig,
  readCodexMcpServerStatus,
  readCodexUserMcpLayer,
} from './codex-mcp.utils';

const USER_LAYER = {
  name: { type: 'user', file: '/home/u/.codex/config.toml', profile: null },
  version: 'sha256:x',
};
const PROJECT_LAYER = {
  name: { type: 'project', dotCodexFolder: '/repo/.codex' },
  version: 'sha256:y',
};

/** A `config/read` result as codex 0.161.0 answers it, trimmed. */
const CONFIG_RESULT = {
  config: {
    mcp_servers: {
      playwright: {
        command: 'npx',
        args: ['@playwright/mcp@latest'],
        env: { SECRET_TOKEN: 'must-never-surface' },
        enabled: true,
      },
      'playwright-2': { command: 'npx', enabled: false },
      linear: { url: 'https://mcp.linear.app/mcp' },
      local: { command: './tool' },
    },
  },
  origins: {
    'mcp_servers.playwright.command': USER_LAYER,
    'mcp_servers.playwright.env.SECRET_TOKEN': USER_LAYER,
    'mcp_servers.playwright-2.command': USER_LAYER,
    'mcp_servers.linear.url': USER_LAYER,
    'mcp_servers.local.command': PROJECT_LAYER,
  },
  layers: null,
};

/** `McpServerStatus` entries as an ephemeral thread's listing reports them (0.161.0). */
function status(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'x',
    runtimeStatus: 'connected',
    pluginId: null,
    httpOrigin: null,
    serverInfo: null,
    serverCapabilities: null,
    tools: {},
    toolsError: null,
    resources: [],
    resourceTemplates: [],
    authStatus: 'unsupported',
    ...overrides,
  };
}

const PAGE = [
  status({
    name: 'codex_apps',
    httpOrigin: 'https://chatgpt.com',
    authStatus: 'bearerToken',
    tools: { a: {}, b: {}, c: {} },
  }),
  status({
    name: 'code-review',
    runtimeStatus: 'disabled',
    pluginId: 'code-review@openai-bundled',
  }),
  status({ name: 'playwright', tools: { navigate: {}, click: {} } }),
  status({ name: 'playwright-2', runtimeStatus: 'disabled' }),
  status({
    name: 'linear',
    runtimeStatus: 'authenticationRequired',
    httpOrigin: 'https://mcp.linear.app',
    authStatus: 'notLoggedIn',
  }),
  status({ name: 'local', runtimeStatus: 'failed', toolsError: 'boom' }),
];

const line = (frame: unknown): string => `${JSON.stringify(frame)}\n`;

describe('readCodexMcpConfig', () => {
  it('places each server in the layer that DEFINES it, with its own enabled flag', () => {
    const config = readCodexMcpConfig(CONFIG_RESULT);
    expect(config.get('playwright')).toMatchObject({
      layer: 'user',
      enabled: true,
      command: 'npx',
    });
    expect(config.get('playwright-2')).toMatchObject({
      layer: 'user',
      enabled: false,
    });
    expect(config.get('linear')).toMatchObject({
      layer: 'user',
      url: 'https://mcp.linear.app/mcp',
    });
    expect(config.get('local')).toMatchObject({ layer: 'project' });
  });

  it('reads a server none of whose keys has an origin as a layer it never writes', () => {
    const config = readCodexMcpConfig({
      config: { mcp_servers: { orphan: { command: 'x' } } },
      origins: {},
    });
    expect(config.get('orphan')?.layer).toBe('other');
  });

  it('answers an empty map for a result without servers', () => {
    expect(readCodexMcpConfig(null).size).toBe(0);
    expect(readCodexMcpConfig({ config: {} }).size).toBe(0);
  });
});

describe('codexMcpStatus', () => {
  const read = (overrides: Record<string, unknown>) =>
    readCodexMcpServerStatus(status(overrides))!;

  it.each([
    ['connected', 'connected'],
    ['starting', 'loading'],
    ['authenticationRequired', 'needs_auth'],
    ['failed', 'failed'],
    ['cancelled', 'failed'],
    ['disabled', 'disabled'],
    ['notStarted', 'unknown'],
  ])('maps the thread’s %s to %s', (runtime, expected) => {
    expect(codexMcpStatus(read({ runtimeStatus: runtime }), null).status).toBe(
      expected,
    );
  });

  it('lets the config’s own enabled=false outrank a live connection', () => {
    expect(
      codexMcpStatus(read({ runtimeStatus: 'connected' }), {
        layer: 'user',
        enabled: false,
      }).status,
    ).toBe('disabled');
  });

  it('falls back to the sign-in state and discovery failure without a thread', () => {
    expect(
      codexMcpStatus(
        read({ runtimeStatus: null, authStatus: 'notLoggedIn' }),
        null,
      ).status,
    ).toBe('needs_auth');
    expect(
      codexMcpStatus(read({ runtimeStatus: null, toolsError: 'nope' }), null),
    ).toEqual({ status: 'failed', detail: 'nope' });
    expect(codexMcpStatus(read({ runtimeStatus: null }), null).status).toBe(
      'unknown',
    );
  });
});

describe('codexMcpRow', () => {
  const config = readCodexMcpConfig(CONFIG_RESULT);
  const rowOf = (name: string) => {
    const entry = PAGE.find((s) => s.name === name)!;
    return codexMcpRow(
      readCodexMcpServerStatus(entry)!,
      config.get(name) ?? null,
    );
  };

  it('offers a switch for a server codex’s user config defines', () => {
    expect(rowOf('playwright')).toMatchObject({
      status: 'connected',
      transport: 'stdio',
      target: 'npx',
      toolCount: 2,
      plugin: null,
      toggleUnavailableReason: null,
    });
    expect(rowOf('playwright')).not.toHaveProperty('signInUnavailableReason');
  });

  it('says why a built-in server has neither a switch nor a sign-in', () => {
    expect(rowOf('codex_apps')).toMatchObject({
      status: 'connected',
      transport: 'http',
      target: 'https://chatgpt.com',
      toolCount: 3,
      toggleUnavailableReason: CODEX_BUILTIN_TOGGLE_REASON,
      signInUnavailableReason: CODEX_BUILTIN_SIGN_IN_REASON,
    });
  });

  it('names the plugin a server comes with and refuses its switch', () => {
    const row = rowOf('code-review');
    expect(row.plugin).toBe('code-review@openai-bundled');
    expect(row.status).toBe('disabled');
    expect(row.toggleUnavailableReason).toContain('code-review@openai-bundled');
    // A plugin's server is one `codex mcp login` can find.
    expect(row).not.toHaveProperty('signInUnavailableReason');
  });

  it('refuses the switch for a project-defined server', () => {
    expect(rowOf('local')).toMatchObject({
      status: 'failed',
      detail: 'boom',
      toggleUnavailableReason: CODEX_PROJECT_TOGGLE_REASON,
    });
  });

  it('reports no tool count for a server that is not connected', () => {
    expect(rowOf('playwright-2').toolCount).toBeNull();
    expect(rowOf('linear')).toMatchObject({
      status: 'needs_auth',
      toolCount: null,
    });
  });

  it('never carries a server’s environment into a row', () => {
    expect(
      JSON.stringify(PAGE.map((s) => rowOf(s.name as string))),
    ).not.toContain('must-never-surface');
  });
});

describe('a node’s per-turn switch (codexTurnMcpOverrides / codexTurnToggleReason)', () => {
  it('switches a config server off by its own key, Apps by the feature flag, and nothing else', () => {
    expect(
      codexTurnMcpOverrides(CONFIG_RESULT, [
        'playwright',
        'local',
        'codex_apps',
        'cua_repl',
        'playwright',
      ]),
    ).toEqual({
      config: {
        'mcp_servers.playwright.enabled': false,
        // A project-layer definition takes the same key.
        'mcp_servers.local.enabled': false,
        'features.apps': false,
      },
      // A plugin's server is not in config.toml: an `enabled` override for it
      // would fail the whole thread, so it is left alone.
      unreachable: ['cua_repl'],
    });
  });

  it('never writes a key for a name codex cannot address as one config key', () => {
    const result = {
      config: { mcp_servers: { 'a.b': { command: 'x' } } },
      origins: { 'mcp_servers.a.b.command': USER_LAYER },
    };
    expect(codexTurnMcpOverrides(result, ['a.b'])).toEqual({
      config: {},
      unreachable: ['a.b'],
    });
  });

  it('answers each listing row with the same decision', () => {
    const config = readCodexMcpConfig(CONFIG_RESULT);
    expect(
      codexTurnToggleReason('playwright', null, config.get('playwright')!),
    ).toBeNull();
    expect(codexTurnToggleReason('codex_apps', null, null)).toBeNull();
    expect(
      codexTurnToggleReason(
        'cua_repl',
        'unified-computer-use@openai-bundled',
        null,
      ),
    ).toContain('unified-computer-use@openai-bundled');
    expect(codexTurnToggleReason('other_builtin', null, null)).toContain(
      'built into codex',
    );
  });

  it('puts that answer on the listing row', () => {
    const row = codexMcpRow(
      readCodexMcpServerStatus(
        status({
          name: 'cua_repl',
          pluginId: 'unified-computer-use@openai-bundled',
        }),
      )!,
      null,
    );
    expect(row.turnToggleUnavailableReason).toContain('whole plugin');
  });
});

describe('codexMcpToggleRefusal', () => {
  it('allows only a server the user config defines', () => {
    expect(codexMcpToggleRefusal(CONFIG_RESULT, 'playwright')).toBeNull();
    expect(codexMcpToggleRefusal(CONFIG_RESULT, 'local')).toContain(
      CODEX_PROJECT_TOGGLE_REASON,
    );
    expect(codexMcpToggleRefusal(CONFIG_RESULT, 'codex_apps')).toContain(
      'is not defined in codex',
    );
  });
});

describe('CodexMcpListing', () => {
  /** Feed the dialogue as runCommand would: frames out, accumulated stdout in. */
  function drive(
    listing: CodexMcpListing,
    replies: (sent: Record<string, unknown>[]) => string[],
  ): { sent: Record<string, unknown>[]; stdout: string } {
    const sent = listing
      .frames()
      .map((frame) => JSON.parse(frame) as Record<string, unknown>);
    let stdout = '';
    for (let round = 0; round < 20 && !listing.settled(stdout); round += 1) {
      const chunk = replies(sent).join('');
      if (chunk === '') {
        break;
      }
      stdout += chunk;
      for (const frame of listing.converse(stdout)) {
        sent.push(JSON.parse(frame) as Record<string, unknown>);
      }
    }
    return { sent, stdout };
  }

  /** A server that answers each request once, by id. */
  function server(
    pages: unknown[][],
  ): (sent: Record<string, unknown>[]) => string[] {
    const answered = new Set<unknown>();
    return (sent) => {
      const out: string[] = [];
      for (const frame of sent) {
        if (frame.id === undefined || answered.has(frame.id)) {
          continue;
        }
        answered.add(frame.id);
        switch (frame.method) {
          case 'initialize':
            out.push(line({ id: frame.id, result: {} }));
            break;
          case 'config/read':
            out.push(line({ id: frame.id, result: CONFIG_RESULT }));
            break;
          case 'thread/start':
            out.push(line({ id: frame.id, result: { thread: { id: 'T1' } } }));
            break;
          case 'mcpServerStatus/list': {
            const params = frame.params as Record<string, unknown>;
            const page =
              params.cursor === undefined ? 0 : Number(params.cursor);
            const next = page + 1 < pages.length ? String(page + 1) : null;
            out.push(
              line({
                id: frame.id,
                result: { data: pages[page], nextCursor: next },
              }),
            );
            break;
          }
          default:
            break;
        }
      }
      return out;
    };
  }

  it('opens an EPHEMERAL thread in the folder and asks about that thread', () => {
    const listing = new CodexMcpListing('1.0.0', '/repo');
    const { sent, stdout } = drive(listing, server([PAGE]));
    const start = sent.find((frame) => frame.method === 'thread/start');
    expect(start?.params).toEqual({ cwd: '/repo', ephemeral: true });
    const ask = sent.find((frame) => frame.method === 'mcpServerStatus/list');
    expect(ask?.params).toMatchObject({
      threadId: 'T1',
      detail: 'toolsAndAuthOnly',
    });
    const outcome = listing.outcome(stdout);
    expect(outcome.ok && outcome.servers.map((row) => row.name)).toEqual([
      'codex_apps',
      'code-review',
      'playwright',
      'playwright-2',
      'linear',
      'local',
    ]);
  });

  it('follows the cursor across pages', () => {
    const listing = new CodexMcpListing('1.0.0', '/repo');
    const { sent, stdout } = drive(
      listing,
      server([PAGE.slice(0, 2), PAGE.slice(2)]),
    );
    expect(
      sent.filter((frame) => frame.method === 'mcpServerStatus/list'),
    ).toHaveLength(2);
    const outcome = listing.outcome(stdout);
    expect(outcome.ok && outcome.servers).toHaveLength(PAGE.length);
  });

  it('stops following pages at the cap', () => {
    const pages = Array.from({ length: CODEX_MCP_STATUS_MAX_PAGES + 3 }, () => [
      PAGE[0],
    ]);
    const listing = new CodexMcpListing('1.0.0', '/repo');
    const { sent } = drive(listing, server(pages));
    expect(
      sent.filter((frame) => frame.method === 'mcpServerStatus/list'),
    ).toHaveLength(CODEX_MCP_STATUS_MAX_PAGES);
  });

  it('narrows the ask to one server for a health read', () => {
    const listing = new CodexMcpListing('1.0.0', '/repo', 'playwright');
    const { sent } = drive(listing, server([[PAGE[2]]]));
    expect(
      sent.find((frame) => frame.method === 'mcpServerStatus/list')?.params,
    ).toMatchObject({ serverName: 'playwright' });
  });

  it('does not settle on a reply split mid-line', () => {
    const listing = new CodexMcpListing('1.0.0', '/repo');
    const start = line({ id: 3, result: { thread: { id: 'T1' } } });
    expect(listing.converse(start.slice(0, 10))).toEqual([]);
    expect(listing.converse(start)).toHaveLength(1);
  });

  it('reports a refused thread as the reason, not as no servers', () => {
    const listing = new CodexMcpListing('1.0.0', '/repo');
    const stdout =
      line({ id: 2, result: CONFIG_RESULT }) +
      line({ id: 3, error: { code: -32600, message: 'not trusted' } });
    expect(listing.settled(stdout)).toBe(true);
    expect(listing.outcome(stdout)).toEqual({
      ok: false,
      reason: 'codex could not open a thread to list from: not trusted',
    });
  });

  describe('servers still starting', () => {
    const opened =
      line({ id: 2, result: CONFIG_RESULT }) +
      line({ id: 3, result: { thread: { id: 'T1' } } });
    const startingPage = (id: number) =>
      line({
        id,
        result: {
          data: [status({ name: 'codex_apps', runtimeStatus: 'starting' })],
          nextCursor: null,
        },
      });
    const readyPage = (id: number) =>
      line({
        id,
        result: {
          data: [status({ name: 'codex_apps', runtimeStatus: 'connected' })],
          nextCursor: null,
        },
      });
    const started = (state: string) =>
      line({
        method: 'mcpServer/startupStatus/updated',
        params: {
          threadId: 'T1',
          name: 'codex_apps',
          status: state,
          error: null,
        },
      });

    it('asks again once codex says the server finished starting', () => {
      const listing = new CodexMcpListing('1.0.0', '/repo');
      let stdout = opened;
      expect(listing.converse(stdout)).toHaveLength(1);
      stdout += startingPage(4);
      // Still starting: nothing to settle on, nothing to ask yet.
      expect(listing.converse(stdout)).toEqual([]);
      expect(listing.settled(stdout)).toBe(false);
      stdout += started('ready');
      const again = listing.converse(stdout);
      expect(again).toHaveLength(1);
      expect(JSON.parse(again[0]!)).toMatchObject({
        id: 5,
        method: 'mcpServerStatus/list',
      });
      stdout += readyPage(5);
      expect(listing.settled(stdout)).toBe(true);
      const outcome = listing.outcome(stdout);
      expect(outcome.ok && outcome.servers[0]?.status).toBe('connected');
    });

    it('asks again at once when codex said so before the listing came back', () => {
      const listing = new CodexMcpListing('1.0.0', '/repo');
      let stdout = opened;
      listing.converse(stdout);
      stdout += started('ready') + startingPage(4);
      expect(listing.converse(stdout)).toHaveLength(1);
    });

    it('serves the listing it has when the read ends while it waits', () => {
      const listing = new CodexMcpListing('1.0.0', '/repo');
      const stdout = opened + startingPage(4);
      listing.converse(stdout);
      const outcome = listing.outcome(null);
      expect(outcome.ok && outcome.servers[0]?.status).toBe('loading');
    });

    it('stops asking again after its bound and serves what it has', () => {
      const listing = new CodexMcpListing('1.0.0', '/repo');
      let stdout = opened;
      listing.converse(stdout);
      let id = 4;
      for (let round = 0; round < 10 && !listing.settled(stdout); round += 1) {
        stdout += startingPage(id) + started('ready');
        id += 1;
        listing.converse(stdout);
      }
      expect(listing.settled(stdout)).toBe(true);
      // The first ask plus CODEX_MCP_STATUS_MAX_RELISTS (3) re-asks.
      expect(id).toBe(8);
    });
  });

  it('reports a read that never ended as a failure', () => {
    expect(new CodexMcpListing('1.0.0', '/repo').outcome(null).ok).toBe(false);
  });

  it('still lists when config/read is refused, with every row unplaced', () => {
    const listing = new CodexMcpListing('1.0.0', '/repo');
    const stdout =
      line({ id: 2, error: { code: -1, message: 'no' } }) +
      line({ id: 3, result: { thread: { id: 'T1' } } });
    const ask = listing.converse(stdout);
    expect(ask).toHaveLength(1);
    const full =
      stdout + line({ id: 4, result: { data: [PAGE[2]], nextCursor: null } });
    expect(listing.settled(full)).toBe(true);
    const outcome = listing.outcome(full);
    expect(outcome.ok && outcome.servers[0]?.toggleUnavailableReason).toBe(
      CODEX_BUILTIN_TOGGLE_REASON,
    );
  });
});

describe('readCodexUserMcpLayer', () => {
  const layer = (name: unknown, config: unknown, version = 'sha256:u') => ({
    name,
    version,
    config,
    disabledReason: null,
  });

  it('reads the BASE user layer’s raw table — not a profile layer, not the effective config', () => {
    const result = {
      config: { mcp_servers: { a: { command: 'x', enabled: true } } },
      layers: [
        layer(
          { type: 'user', file: '/h/.codex/profiles/p.toml', profile: 'p' },
          { mcp_servers: { fromProfile: { command: 'p' } } },
          'sha256:profile',
        ),
        layer(
          { type: 'user', file: '/h/.codex/config.toml', profile: null },
          { model: 'm', mcp_servers: { a: { command: 'x' } } },
        ),
        layer({ type: 'system', file: '/etc/codex/config.toml' }, {}),
      ],
    };
    expect(readCodexUserMcpLayer(result)).toEqual({
      ok: true,
      servers: { a: { command: 'x' } },
      version: 'sha256:u',
      file: '/h/.codex/config.toml',
    });
  });

  it('reads a user layer with no table as an empty one — a fresh home', () => {
    expect(
      readCodexUserMcpLayer({
        layers: [
          layer({ type: 'user', file: '/h/config.toml', profile: null }, {}),
        ],
      }),
    ).toMatchObject({ ok: true, servers: {} });
  });

  it('refuses what a whole-table save could not write back', () => {
    expect(readCodexUserMcpLayer({ layers: [] })).toMatchObject({ ok: false });
    expect(
      readCodexUserMcpLayer({
        layers: [
          layer(
            { type: 'user', file: '/f', profile: null },
            { mcp_servers: { a: 'x' } },
          ),
        ],
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/mcp_servers\.a/),
    });
  });
});
