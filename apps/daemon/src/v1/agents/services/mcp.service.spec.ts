import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentKind } from '../../runs/runs.types';
import type { AgentMcpServer } from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { McpService } from './mcp.service';
import { ProcessRegistry } from './process-registry';

const dirs: string[] = [];

/** A real directory, because `resolveValidCwd` stats and canonicalizes it. */
function realDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-svc-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

function server(name: string): AgentMcpServer {
  return {
    name,
    target: `node ${name}.js`,
    transport: 'stdio',
    status: 'connected',
    detail: null,
  };
}

interface Harness {
  service: McpService;
  listMcpServers: ReturnType<typeof vi.fn>;
  setNow: (ms: number) => void;
}

function harness(
  impl: (input: { cwd: string }) => Promise<AgentMcpServer[]>,
  version: string | null = '2.1.220',
): Harness {
  const listMcpServers = vi.fn(impl);
  const adapter = {
    listMcpServers,
    getConfig: () => ({ mcp: { listingUnavailableReason: null } }),
  } as unknown as AgentAdapter;
  const registry = {
    for: () => adapter,
  } as unknown as AgentAdapterRegistry;
  let now = 1_000;
  const service = new McpService(registry, new ProcessRegistry(), {
    now: () => now,
    resolveVersionFn: () => Promise.resolve(version),
  });
  return {
    service,
    listMcpServers,
    setNow: (ms) => {
      now = ms;
    },
  };
}

describe('McpService.list', () => {
  it('serves a second read of the same folder from cache', async () => {
    const cwd = realDir();
    const { service, listMcpServers } = harness(() =>
      Promise.resolve([server('a')]),
    );

    await service.list(AgentKind.Claude, cwd);
    await service.list(AgentKind.Claude, cwd);

    // Asking twice means health-checking the user's servers twice.
    expect(listMcpServers).toHaveBeenCalledTimes(1);
  });

  it('does NOT serve one folder’s rows for another folder', async () => {
    // The cwd half of the key. Without it the panel shows folder A's servers
    // while the user is looking at folder B — wrong, not merely stale.
    const dirA = realDir();
    const dirB = realDir();
    const { service, listMcpServers } = harness((input) =>
      Promise.resolve([server(input.cwd === dirA ? 'from-a' : 'from-b')]),
    );

    const a = await service.list(AgentKind.Claude, dirA);
    const b = await service.list(AgentKind.Claude, dirB);

    expect(a.servers.map((s) => s.name)).toEqual(['from-a']);
    expect(b.servers.map((s) => s.name)).toEqual(['from-b']);
    expect(listMcpServers).toHaveBeenCalledTimes(2);
  });

  it('does NOT serve one agent’s rows for another agent', async () => {
    const cwd = realDir();
    const seen: AgentKind[] = [];
    const listMcpServers = vi.fn(() => Promise.resolve([server('x')]));
    const registry = {
      for: (kind: AgentKind) => {
        seen.push(kind);
        return {
          listMcpServers,
          getConfig: () => ({ mcp: { listingUnavailableReason: null } }),
        } as unknown as AgentAdapter;
      },
    } as unknown as AgentAdapterRegistry;
    const service = new McpService(registry, new ProcessRegistry(), {
      resolveVersionFn: () => Promise.resolve('1'),
    });

    await service.list(AgentKind.Claude, cwd);
    await service.list(AgentKind.CursorAgent, cwd);

    expect(seen).toEqual([AgentKind.Claude, AgentKind.CursorAgent]);
    expect(listMcpServers).toHaveBeenCalledTimes(2);
  });

  it('re-asks after the binary version changes', async () => {
    // A CLI upgrade can reword the output the parser reads, so a listing is
    // only reusable while the binary that produced it is.
    const cwd = realDir();
    const listMcpServers = vi.fn(() => Promise.resolve([server('a')]));
    const registry = {
      for: () =>
        ({
          listMcpServers,
          getConfig: () => ({ mcp: { listingUnavailableReason: null } }),
        }) as unknown as AgentAdapter,
    } as unknown as AgentAdapterRegistry;
    let version = '2.1.220';
    const service = new McpService(registry, new ProcessRegistry(), {
      resolveVersionFn: () => Promise.resolve(version),
    });

    await service.list(AgentKind.Claude, cwd);
    version = '2.2.0';
    await service.list(AgentKind.Claude, cwd);

    expect(listMcpServers).toHaveBeenCalledTimes(2);
  });

  it('re-asks once the cached reading goes stale', async () => {
    const cwd = realDir();
    const { service, listMcpServers, setNow } = harness(() =>
      Promise.resolve([server('a')]),
    );

    await service.list(AgentKind.Claude, cwd);
    setNow(1_000 + 5 * 60_000 + 1);
    await service.list(AgentKind.Claude, cwd);

    expect(listMcpServers).toHaveBeenCalledTimes(2);
  });

  it('re-asks immediately when the caller asks for a refresh', async () => {
    // The Refresh control's whole job: nothing else re-dials a server that has
    // since come back up.
    const cwd = realDir();
    const { service, listMcpServers } = harness(() =>
      Promise.resolve([server('a')]),
    );

    await service.list(AgentKind.Claude, cwd);
    await service.list(AgentKind.Claude, cwd, true);

    expect(listMcpServers).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent reads of one key onto ONE listing', async () => {
    // Asking twice at once would health-check — and so launch — the user's own
    // MCP servers twice over.
    const cwd = realDir();
    let release!: (servers: AgentMcpServer[]) => void;
    const { service, listMcpServers } = harness(
      () =>
        new Promise<AgentMcpServer[]>((resolve) => {
          release = resolve;
        }),
    );

    const first = service.list(AgentKind.Claude, cwd);
    const second = service.list(AgentKind.Claude, cwd);
    await Promise.resolve();
    release([server('a')]);

    expect(await first).toEqual(await second);
    expect(listMcpServers).toHaveBeenCalledTimes(1);
  });

  it('a concurrent refresh joins the read already running', async () => {
    // A double-clicked Refresh must not spawn a second health check.
    const cwd = realDir();
    let release!: (servers: AgentMcpServer[]) => void;
    const { service, listMcpServers } = harness(
      () =>
        new Promise<AgentMcpServer[]>((resolve) => {
          release = resolve;
        }),
    );

    const first = service.list(AgentKind.Claude, cwd, true);
    const second = service.list(AgentKind.Claude, cwd, true);
    await Promise.resolve();
    release([server('a')]);
    await Promise.all([first, second]);

    expect(listMcpServers).toHaveBeenCalledTimes(1);
  });

  it('degrades to an empty list when the adapter throws', async () => {
    // This feeds a panel — a broken CLI must cost the list, not the request.
    const cwd = realDir();
    const { service } = harness(() => Promise.reject(new Error('boom')));

    await expect(service.list(AgentKind.Claude, cwd)).resolves.toEqual({
      servers: [],
      unavailableReason: null,
    });
  });

  it('releases the in-flight slot after a failure, so the next read retries', async () => {
    // Without the `.finally` eviction a single failure would wedge the key
    // forever, and Refresh would keep handing back the rejected promise.
    const cwd = realDir();
    let attempt = 0;
    const { service, listMcpServers } = harness(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('boom'))
        : Promise.resolve([server('recovered')]);
    });

    await service.list(AgentKind.Claude, cwd);
    const after = await service.list(AgentKind.Claude, cwd, true);

    expect(listMcpServers).toHaveBeenCalledTimes(2);
    expect(after.servers.map((s) => s.name)).toEqual(['recovered']);
  });

  it('carries an adapter’s declared absence through instead of asking it', async () => {
    // "This folder has no servers" and "this CLI cannot tell us" are both an
    // empty list. The reason is what keeps them distinguishable WITHOUT any
    // reader branching on which CLI it is holding — and a CLI that cannot
    // answer must not be spawned to prove it.
    const cwd = realDir();
    const listMcpServers = vi.fn(() => Promise.resolve([]));
    const registry = {
      for: () =>
        ({
          listMcpServers,
          getConfig: () => ({
            mcp: { listingUnavailableReason: 'no listing on this CLI yet' },
          }),
        }) as unknown as AgentAdapter,
    } as unknown as AgentAdapterRegistry;
    const service = new McpService(registry, new ProcessRegistry(), {
      resolveVersionFn: () => Promise.resolve('1'),
    });

    await expect(service.list(AgentKind.CursorAgent, cwd)).resolves.toEqual({
      servers: [],
      unavailableReason: 'no listing on this CLI yet',
    });
    expect(listMcpServers).not.toHaveBeenCalled();
  });

  it('the shipped cursor adapter is the one that declares an absence, claude does not', async () => {
    // Pins the two REAL adapters, not a fixture: if cursor gains a listing (or
    // claude loses one) this is what makes the panel's copy follow.
    const { ClaudeAdapter } = await import('../adapters/claude/claude.adapter');
    const { CursorAcpAdapter } =
      await import('../adapters/cursor-acp/cursor-acp.adapter');

    expect(
      new ClaudeAdapter().getConfig().mcp.listingUnavailableReason,
    ).toBeNull();
    expect(
      new CursorAcpAdapter().getConfig().mcp.listingUnavailableReason,
    ).toEqual(expect.stringContaining('cursor-agent'));
  });

  it('rejects a cwd that is not an absolute existing directory', async () => {
    const { service } = harness(() => Promise.resolve([]));

    await expect(
      service.list(AgentKind.Claude, 'relative/path'),
    ).rejects.toThrow(/absolute/);
  });

  it('registers the listing child so shutdown can reap its process group', async () => {
    // The listing forks the user's MCP servers; an unregistered child orphans
    // them on shutdown.
    const cwd = realDir();
    const processes = new ProcessRegistry();
    const registerSpy = vi.spyOn(processes, 'register');
    const adapter = {
      getConfig: () => ({ mcp: { listingUnavailableReason: null } }),
      listMcpServers: (
        _input: { cwd: string },
        options: { onSpawn?: (child: unknown) => void },
      ) => {
        options.onSpawn?.({ pid: 7, kill: () => true, once: () => undefined });
        return Promise.resolve([server('a')]);
      },
    } as unknown as AgentAdapter;
    const service = new McpService(
      { for: () => adapter } as unknown as AgentAdapterRegistry,
      processes,
      { resolveVersionFn: () => Promise.resolve('1') },
    );

    await service.list(AgentKind.Claude, cwd);

    expect(
      registerSpy.mock.calls.some(([id]) => String(id).startsWith('mcp:list:')),
    ).toBe(true);
  });
});
