// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliKind } from '../../shared/contracts';
import type { DaemonApis } from '../daemon-api';
import { type AgentMcpState, useAgentMcp } from './use-agent-mcp';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

/** Drive the hook and expose its latest value. */
function mount(
  agentsApi: DaemonApis['agents'],
  kinds: readonly CliKind[],
  cwd: string | null,
): () => AgentMcpState {
  let latest!: AgentMcpState;
  function Probe(): null {
    latest = useAgentMcp(agentsApi, kinds, cwd);
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Probe />);
  });
  return () => latest;
}

/**
 * Drive the hook across several prop values — the same root, re-rendered, so
 * the effect re-runs the way it does when the user switches chats.
 */
function mountRerenderable(agentsApi: DaemonApis['agents']): {
  get: () => AgentMcpState;
  show: (kinds: readonly CliKind[], cwd: string | null) => void;
} {
  let latest!: AgentMcpState;
  function Probe({
    kinds,
    cwd,
  }: {
    kinds: readonly CliKind[];
    cwd: string | null;
  }): null {
    latest = useAgentMcp(agentsApi, kinds, cwd);
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  return {
    get: () => latest,
    show: (kinds, cwd) => {
      act(() => {
        root!.render(<Probe kinds={kinds} cwd={cwd} />);
      });
    },
  };
}

/** Flush the hook's promise chain. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The request shape the hook sends, so `mock.calls` stays typed. */
type McpRequest = { agent: CliKind; cwd: string; refresh?: string };

function apiReturning(
  listAgentMcpServers: (request: McpRequest) => Promise<unknown>,
  setAgentMcpServerEnabled: (body: {
    setMcpServerEnabledDto: {
      agent: CliKind;
      cwd: string;
      server: string;
      enabled: boolean;
    };
  }) => Promise<unknown> = () => Promise.resolve(listing),
): DaemonApis['agents'] {
  return {
    listAgentMcpServers,
    setAgentMcpServerEnabled,
  } as unknown as DaemonApis['agents'];
}

const listing = { servers: [], unavailableReason: null };

describe('useAgentMcp', () => {
  it('asks each kind once for the run’s folder', async () => {
    const call = vi.fn((_request: McpRequest) => Promise.resolve(listing));
    const get = mount(apiReturning(call), ['claude', 'cursor-agent'], '/proj');
    await settle();

    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledWith({ agent: 'claude', cwd: '/proj' });
    expect(get().byKind.get('claude')).toEqual(listing);
  });

  it('does NOT bypass the daemon’s cache on the first read', async () => {
    // The read health-checks — launching the user's own MCP servers — so
    // merely opening the panel must not force a re-dial.
    const call = vi.fn((_request: McpRequest) => Promise.resolve(listing));
    mount(apiReturning(call), ['claude'], '/proj');
    await settle();

    expect(call.mock.calls[0]?.[0]).not.toHaveProperty('refresh');
  });

  it('bypasses the daemon’s cache once the user asks for a refresh', async () => {
    // Without this Refresh is a lie: the daemon would keep serving the same
    // cached reading and a recovered server would never turn green.
    const call = vi.fn((_request: McpRequest) => Promise.resolve(listing));
    const get = mount(apiReturning(call), ['claude'], '/proj');
    await settle();

    act(() => {
      get().refresh();
    });
    await settle();

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]?.[0]).toEqual({
      agent: 'claude',
      cwd: '/proj',
      refresh: 'true',
    });
  });

  it('gives a transport failure its own sentence, so it cannot read as "No servers"', async () => {
    // The panel renders an empty listing with no reason as "No servers" — a
    // claim about the user's CONFIGURATION. A failed request must not make it,
    // and this is the last hop where the daemon's own failure/empty split can
    // still be thrown away. The client's per-request budget is shorter than
    // the daemon's worst case, so this path is the COMMON one on a slow read.
    const get = mount(
      apiReturning(
        vi.fn((_request: McpRequest) => Promise.reject(new Error('offline'))),
      ),
      ['claude'],
      '/proj',
    );
    await settle();

    const listed = get().byKind.get('claude');
    expect(listed?.servers).toEqual([]);
    expect(listed?.unavailableReason).not.toBeNull();
    expect(get().loading).toBe(false);
  });

  it('stays loading while a refresh re-reads rows that are already on screen', async () => {
    // Pins the `pending` half of `loading`. It is the ONLY state where the two
    // terms disagree — rows present, a read in flight — and it is exactly what
    // disables the Refresh button. Drop `pending` and this is what breaks.
    let release!: (value: unknown) => void;
    let calls = 0;
    const call = vi.fn((_request: McpRequest) => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(listing)
        : new Promise<unknown>((resolve) => {
            release = resolve;
          });
    });
    const get = mount(apiReturning(call), ['claude'], '/proj');
    await settle();
    expect(get().loading).toBe(false);

    act(() => {
      get().refresh();
    });

    expect(get().byKind.get('claude')).toEqual(listing);
    expect(get().loading).toBe(true);

    release(listing);
    await settle();
    expect(get().loading).toBe(false);
  });

  it('is already loading on the very first render, before the effect runs', async () => {
    // Pins the `awaitingFirstAnswer` half. Effects run after paint, so without
    // it the panel paints one frame of "No servers" before asking anything.
    const seen: boolean[] = [];
    const call = vi.fn((_request: McpRequest) => Promise.resolve(listing));
    // Hoisted: rebuilding the api object per render changes the effect's
    // identity every time and spins it forever.
    const api = apiReturning(call);
    const kinds: CliKind[] = ['claude'];
    function Probe(): null {
      seen.push(useAgentMcp(api, kinds, '/proj').loading);
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<Probe />);
    });

    expect(seen[0]).toBe(true);
    await settle();
  });

  it('asks nothing, and shows no spinner, when the run has no folder', async () => {
    const call = vi.fn((_request: McpRequest) => Promise.resolve(listing));
    const get = mount(apiReturning(call), ['claude'], null);
    await settle();

    expect(call).not.toHaveBeenCalled();
    expect(get().loading).toBe(false);
    expect(get().byKind.size).toBe(0);
  });

  it('reports loading while a read is in flight, and never a bare "no servers"', async () => {
    // The panel renders "No servers" — a claim about the user's configuration
    // — whenever a kind has no listing and nothing is loading. The effect runs
    // after paint, so without the derived loading state that claim is on
    // screen for a frame before anything has been asked.
    let release!: (value: unknown) => void;
    const call = vi.fn(
      (_request: McpRequest) =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
    );
    const get = mount(apiReturning(call), ['claude'], '/proj');

    expect(get().loading).toBe(true);
    expect(get().byKind.get('claude')).toBeUndefined();

    release(listing);
    await settle();

    expect(get().loading).toBe(false);
    expect(get().byKind.get('claude')).toEqual(listing);
  });

  it('ignores a read that resolves after the folder has already changed', async () => {
    // Out-of-order resolution: folder A's slow answer must not land in folder
    // B's panel. That is a wrong answer, not a stale one.
    const resolvers = new Map<string, (value: unknown) => void>();
    const call = vi.fn(
      (request: McpRequest) =>
        new Promise<unknown>((resolve) => {
          resolvers.set(request.cwd, resolve);
        }),
    );
    const ui = mountRerenderable(apiReturning(call));
    ui.show(['claude'], '/proj-a');
    await settle();
    ui.show(['claude'], '/proj-b');
    await settle();

    // A answers LAST, long after the user moved on.
    resolvers.get('/proj-b')?.({
      servers: [
        {
          name: 'from-b',
          target: 'node b.js',
          transport: 'stdio',
          status: 'connected',
          detail: null,
        },
      ],
      unavailableReason: null,
    });
    await settle();
    resolvers.get('/proj-a')?.({
      servers: [
        {
          name: 'from-a',
          target: 'node a.js',
          transport: 'stdio',
          status: 'connected',
          detail: null,
        },
      ],
      unavailableReason: null,
    });
    await settle();

    expect(
      ui
        .get()
        .byKind.get('claude')
        ?.servers.map((s) => s.name),
    ).toEqual(['from-b']);
  });

  it('asks nothing when no kinds are in scope', async () => {
    // What keeps a closed panel from health-checking in the background.
    const call = vi.fn((_request: McpRequest) => Promise.resolve(listing));
    mount(apiReturning(call), [], '/proj');
    await settle();

    expect(call).not.toHaveBeenCalled();
  });

  it('reads the daemon’s cache again when the folder changes after a refresh', async () => {
    // Refresh is a ONE-SHOT user intent about the folder on screen. A later
    // automatic read — switching chats, reopening the panel — must go back to
    // the cached reading, or every navigation for the rest of the session
    // re-dials and so re-launches the user's own MCP servers.
    const call = vi.fn((_request: McpRequest) => Promise.resolve(listing));
    const ui = mountRerenderable(apiReturning(call));
    ui.show(['claude'], '/proj-a');
    await settle();

    act(() => {
      ui.get().refresh();
    });
    await settle();
    ui.show(['claude'], '/proj-b');
    await settle();

    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[2]?.[0]).toEqual({
      agent: 'claude',
      cwd: '/proj-b',
    });
  });

  it('reports no listing for a kind that has not answered for the new folder', async () => {
    // `byKind` promises that an absent kind has not answered yet. Keeping the
    // previous folder's rows in it breaks that promise in the one direction
    // that matters: the panel then states folder A's servers as folder B's,
    // which is wrong rather than merely stale.
    const neverAnswers = new Promise<never>(() => undefined);
    const call = vi.fn((request: McpRequest) =>
      request.cwd === '/proj-a'
        ? Promise.resolve({
            servers: [
              {
                name: 'only-in-a',
                target: 'node a.js',
                transport: 'stdio',
                status: 'connected',
                detail: null,
              },
            ],
            unavailableReason: null,
          })
        : neverAnswers,
    );
    const ui = mountRerenderable(apiReturning(call));
    ui.show(['claude'], '/proj-a');
    await settle();
    expect(
      ui
        .get()
        .byKind.get('claude')
        ?.servers.map((entry) => entry.name),
    ).toEqual(['only-in-a']);

    ui.show(['claude'], '/proj-b');
    await settle();

    expect(ui.get().byKind.get('claude')).toBeUndefined();
    expect(ui.get().loading).toBe(true);
  });
});

describe('useAgentMcp — the toggle', () => {
  const row = (name: string, disabled: boolean): unknown => ({
    name,
    target: 'node x.js',
    transport: 'stdio',
    status: 'connected',
    detail: null,
    scope: 'project',
    disabled,
    toggleUnavailableReason: null,
  });

  it('sends the agent, folder, server and desired state', async () => {
    const write = vi.fn(() =>
      Promise.resolve({
        servers: [row('sentry', true)],
        unavailableReason: null,
      }),
    );
    const get = mount(
      apiReturning(() => Promise.resolve(listing), write),
      ['claude'],
      '/proj',
    );
    await settle();

    act(() => {
      get().setEnabled('claude', 'sentry', false);
    });
    await settle();

    expect(write).toHaveBeenCalledWith({
      setMcpServerEnabledDto: {
        agent: 'claude',
        cwd: '/proj',
        server: 'sentry',
        enabled: false,
      },
    });
  });

  it('renders the listing the daemon returned, not the one it asked for', async () => {
    // Deliberately NOT optimistic: the daemon refuses a toggle it cannot
    // honour, so painting the switch first would show a state the next turn
    // will not have.
    const get = mount(
      apiReturning(
        () =>
          Promise.resolve({
            servers: [row('sentry', false)],
            unavailableReason: null,
          }),
        () =>
          Promise.resolve({
            servers: [row('sentry', true)],
            unavailableReason: null,
          }),
      ),
      ['claude'],
      '/proj',
    );
    await settle();
    expect(get().byKind.get('claude')?.servers[0]?.disabled).toBe(false);

    act(() => {
      get().setEnabled('claude', 'sentry', false);
    });
    await settle();

    expect(get().byKind.get('claude')?.servers[0]?.disabled).toBe(true);
  });

  it('surfaces the daemon’s own refusal, so the user learns WHY', async () => {
    const get = mount(
      apiReturning(
        () => Promise.resolve(listing),
        () =>
          Promise.reject(
            new Error('daemon PUT /v1/agents/mcp failed (400): not project'),
          ),
      ),
      ['claude'],
      '/proj',
    );
    await settle();

    act(() => {
      get().setEnabled('claude', 'sentry', false);
    });
    await settle();

    expect(get().toggleError).toContain('not project');
  });

  it('clears a previous failure when the user tries again', async () => {
    let fail = true;
    const get = mount(
      apiReturning(
        () => Promise.resolve(listing),
        () =>
          fail ? Promise.reject(new Error('nope')) : Promise.resolve(listing),
      ),
      ['claude'],
      '/proj',
    );
    await settle();
    act(() => {
      get().setEnabled('claude', 'sentry', false);
    });
    await settle();
    expect(get().toggleError).not.toBeNull();

    fail = false;
    act(() => {
      get().setEnabled('claude', 'sentry', false);
    });
    await settle();

    expect(get().toggleError).toBeNull();
  });

  it('lets the user dismiss the failure', async () => {
    const get = mount(
      apiReturning(
        () => Promise.resolve(listing),
        () => Promise.reject(new Error('nope')),
      ),
      ['claude'],
      '/proj',
    );
    await settle();
    act(() => {
      get().setEnabled('claude', 'sentry', false);
    });
    await settle();

    act(() => {
      get().dismissToggleError();
    });

    expect(get().toggleError).toBeNull();
  });

  it('writes nothing when the run has no folder', async () => {
    const write = vi.fn(() => Promise.resolve(listing));
    const get = mount(
      apiReturning(() => Promise.resolve(listing), write),
      ['claude'],
      null,
    );
    await settle();

    act(() => {
      get().setEnabled('claude', 'sentry', false);
    });
    await settle();

    expect(write).not.toHaveBeenCalled();
  });

  it('drops an answer that arrives after the folder changed', async () => {
    // Out-of-order again, but on the WRITE path: folder A's toggle answer must
    // not land in folder B's panel, which would state A's servers as B's.
    let release!: (value: unknown) => void;
    const ui = mountRerenderable(
      apiReturning(
        () => Promise.resolve(listing),
        () =>
          new Promise<unknown>((resolve) => {
            release = resolve;
          }),
      ),
    );
    ui.show(['claude'], '/proj-a');
    await settle();
    act(() => {
      ui.get().setEnabled('claude', 'sentry', false);
    });
    ui.show(['claude'], '/proj-b');
    await settle();

    release({ servers: [row('from-a', true)], unavailableReason: null });
    await settle();

    expect(
      ui
        .get()
        .byKind.get('claude')
        ?.servers.map((s) => s.name),
    ).not.toContain('from-a');
  });

  it('reports loading while the write is in flight', async () => {
    // What keeps the switch from being clicked twice into a write race.
    let release!: (value: unknown) => void;
    const get = mount(
      apiReturning(
        () => Promise.resolve(listing),
        () =>
          new Promise<unknown>((resolve) => {
            release = resolve;
          }),
      ),
      ['claude'],
      '/proj',
    );
    await settle();
    expect(get().loading).toBe(false);

    act(() => {
      get().setEnabled('claude', 'sentry', false);
    });
    expect(get().loading).toBe(true);

    release(listing);
    await settle();
    expect(get().loading).toBe(false);
  });
});
