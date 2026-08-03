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
): DaemonApis['agents'] {
  return { listAgentMcpServers } as unknown as DaemonApis['agents'];
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

  it('reports a failure as an empty listing, never as a CLI limitation', async () => {
    // A transport failure is ours. Claiming the CLI has no listing would put
    // an untrue sentence in the panel.
    const get = mount(
      apiReturning(
        vi.fn((_request: McpRequest) => Promise.reject(new Error('offline'))),
      ),
      ['claude'],
      '/proj',
    );
    await settle();

    expect(get().byKind.get('claude')).toEqual({
      servers: [],
      unavailableReason: null,
    });
    expect(get().loading).toBe(false);
  });

  it('asks nothing, and shows no spinner, when the run has no folder', async () => {
    const call = vi.fn((_request: McpRequest) => Promise.resolve(listing));
    const get = mount(apiReturning(call), ['claude'], null);
    await settle();

    expect(call).not.toHaveBeenCalled();
    expect(get().loading).toBe(false);
    expect(get().byKind.size).toBe(0);
  });

  it('asks nothing when no kinds are in scope', async () => {
    // What keeps a closed panel from health-checking in the background.
    const call = vi.fn((_request: McpRequest) => Promise.resolve(listing));
    mount(apiReturning(call), [], '/proj');
    await settle();

    expect(call).not.toHaveBeenCalled();
  });
});
