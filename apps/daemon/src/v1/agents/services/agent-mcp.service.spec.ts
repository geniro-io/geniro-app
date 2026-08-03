import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentKind } from '../../runs/runs.types';
import type {
  AgentMcpFolderFacts,
  AgentMcpServer,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentMcpService } from './agent-mcp.service';
import { McpSettingsStore } from './mcp-settings.store';
import { ProcessRegistry } from './process-registry';

const dirs: string[] = [];

/**
 * A real directory, CANONICALIZED — `resolveValidCwd` runs `realpathSync`, and
 * on macOS `os.tmpdir()` sits under the `/var` → `/private/var` symlink, so an
 * un-resolved fixture path never equals what the service actually passes down.
 */
function realDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-svc-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

/**
 * Wait until the adapter has actually been called, rather than counting ticks.
 * The service defers its adapter call (the synchronous-throw guard), and a
 * fixed tick count makes a single-flight regression fail by 5s TIMEOUT instead
 * of by the assertion that names it.
 */
function whenCalled(fn: { mock: { calls: unknown[] } }): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (fn.mock.calls.length > 0) {
        resolve();
        return;
      }
      setTimeout(check, 0);
    };
    check();
  });
}

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
  service: AgentMcpService;
  listMcpServers: ReturnType<typeof vi.fn>;
  setNow: (ms: number) => void;
  settings: McpSettingsStore;
}

interface HarnessOptions {
  version?: string | null;
  /** What the CLI's own config files say — defaults to knowing nothing. */
  facts?: AgentMcpFolderFacts;
}

function harness(
  impl: (input: { cwd: string }) => Promise<AgentMcpServer[]>,
  options: HarnessOptions = {},
): Harness {
  const { version = '2.1.220', facts } = options;
  // The fixtures speak in plain server arrays; the adapter contract is the
  // discriminated result, so wrap here rather than in every case.
  const listMcpServers = vi.fn((input: { cwd: string }) =>
    impl(input).then((servers) => ({ ok: true as const, servers })),
  );
  const adapter = {
    listMcpServers,
    getConfig: () => ({
      mcp: {
        listingUnavailableReason: null,
        toggleUnavailableReason: null,
        notInToggleableScopeReason: 'not a project server',
        userDisabledReason: 'you switched it off yourself',
      },
    }),
    readMcpFolderFacts: () =>
      Promise.resolve(facts ?? { projectServers: [], userDisabled: [] }),
  } as unknown as AgentAdapter;
  const registry = {
    for: () => adapter,
  } as unknown as AgentAdapterRegistry;
  let now = 1_000;
  const settingsFile = join(realDir(), 'mcp-settings.json');
  const settings = new McpSettingsStore({ file: settingsFile });
  const service = new AgentMcpService(
    registry,
    new ProcessRegistry(),
    settings,
    {
      now: () => now,
      resolveVersionFn: () => Promise.resolve(version),
    },
  );
  return {
    service,
    listMcpServers,
    settings,
    setNow: (ms) => {
      now = ms;
    },
  };
}

describe('AgentMcpService.list', () => {
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
    const listMcpServers = vi.fn(() =>
      Promise.resolve({ ok: true as const, servers: [server('x')] }),
    );
    const registry = {
      for: (kind: AgentKind) => {
        seen.push(kind);
        return {
          listMcpServers,
          getConfig: () => ({
            mcp: {
              listingUnavailableReason: null,
              toggleUnavailableReason: null,
              notInToggleableScopeReason: 'not a project server',
              userDisabledReason: 'you switched it off yourself',
            },
          }),
          readMcpFolderFacts: () =>
            Promise.resolve({ projectServers: [], userDisabled: [] }),
        } as unknown as AgentAdapter;
      },
    } as unknown as AgentAdapterRegistry;
    const service = new AgentMcpService(
      registry,
      new ProcessRegistry(),
      new McpSettingsStore({ file: join(realDir(), 'mcp-settings.json') }),
      {
        resolveVersionFn: () => Promise.resolve('1'),
      },
    );

    await service.list(AgentKind.Claude, cwd);
    await service.list(AgentKind.CursorAgent, cwd);

    expect(seen).toEqual([AgentKind.Claude, AgentKind.CursorAgent]);
    expect(listMcpServers).toHaveBeenCalledTimes(2);
  });

  it('re-asks after the binary version changes', async () => {
    // A CLI upgrade can reword the output the parser reads, so a listing is
    // only reusable while the binary that produced it is.
    const cwd = realDir();
    const listMcpServers = vi.fn(() =>
      Promise.resolve({ ok: true as const, servers: [server('a')] }),
    );
    const registry = {
      for: () =>
        ({
          listMcpServers,
          getConfig: () => ({
            mcp: {
              listingUnavailableReason: null,
              toggleUnavailableReason: null,
              notInToggleableScopeReason: 'not a project server',
              userDisabledReason: 'you switched it off yourself',
            },
          }),
          readMcpFolderFacts: () =>
            Promise.resolve({ projectServers: [], userDisabled: [] }),
        }) as unknown as AgentAdapter,
    } as unknown as AgentAdapterRegistry;
    let version = '2.1.220';
    const service = new AgentMcpService(
      registry,
      new ProcessRegistry(),
      new McpSettingsStore({ file: join(realDir(), 'mcp-settings.json') }),
      {
        resolveVersionFn: () => Promise.resolve(version),
      },
    );

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
    await whenCalled(listMcpServers);

    // Asserted BEFORE releasing: with single-flight gone the second call would
    // overwrite `release`, `first` would never settle, and this pin would die
    // on a timeout instead of reporting the coalescing failure.
    expect(listMcpServers).toHaveBeenCalledTimes(1);
    release([server('a')]);
    expect(await first).toEqual(await second);
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
    await whenCalled(listMcpServers);

    expect(listMcpServers).toHaveBeenCalledTimes(1);
    release([server('a')]);
    await Promise.all([first, second]);
  });

  it('degrades to a stated failure when the adapter rejects', async () => {
    // This feeds a panel — a broken CLI must cost the list, not the request.
    // It must NOT come back as a bare empty list either: that is the shape the
    // panel renders as "No servers", i.e. a claim about the user's config.
    const cwd = realDir();
    const { service } = harness(() => Promise.reject(new Error('boom')));

    const result = await service.list(AgentKind.Claude, cwd);

    expect(result.servers).toEqual([]);
    expect(result.unavailableReason).not.toBeNull();
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

  it('does not remember a failed listing as “this folder has no servers”', async () => {
    // The failure degrades the RESPONSE, but it must not be written into the
    // freshness cache: "no servers" is a claim about the user's configuration,
    // and caching it turns one transient failure into five minutes of a panel
    // asserting something untrue with no automatic path back.
    const cwd = realDir();
    let attempt = 0;
    const { service, listMcpServers } = harness(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('boom'))
        : Promise.resolve([server('sentry')]);
    });

    await service.list(AgentKind.Claude, cwd);
    const second = await service.list(AgentKind.Claude, cwd);

    expect(listMcpServers).toHaveBeenCalledTimes(2);
    expect(second.servers.map((s) => s.name)).toEqual(['sentry']);
  });

  it('survives an adapter that throws before returning a promise', async () => {
    // Same contract as the rejected-promise case, and the same reason: this
    // read feeds a panel, so a misbehaving adapter must cost the list and
    // never the request. A synchronous throw walks straight past a bare
    // `.catch` on the call's result.
    const cwd = realDir();
    const { service } = harness(() => {
      throw new Error('boom');
    });

    const result = await service.list(AgentKind.Claude, cwd);

    expect(result.servers).toEqual([]);
    expect(result.unavailableReason).not.toBeNull();
  });

  it('carries an adapter’s declared absence through instead of asking it', async () => {
    // "This folder has no servers" and "this CLI cannot tell us" are both an
    // empty list. The reason is what keeps them distinguishable WITHOUT any
    // reader branching on which CLI it is holding — and a CLI that cannot
    // answer must not be spawned to prove it.
    const cwd = realDir();
    const listMcpServers = vi.fn(() =>
      Promise.resolve({ ok: true as const, servers: [] }),
    );
    const registry = {
      for: () =>
        ({
          listMcpServers,
          getConfig: () => ({
            mcp: { listingUnavailableReason: 'no listing on this CLI yet' },
          }),
        }) as unknown as AgentAdapter,
    } as unknown as AgentAdapterRegistry;
    const service = new AgentMcpService(
      registry,
      new ProcessRegistry(),
      new McpSettingsStore({ file: join(realDir(), 'mcp-settings.json') }),
      { resolveVersionFn: () => Promise.resolve('1') },
    );

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
    // The name says "existing directory" too, so assert that arm rather than
    // leaving it to the reader to assume `resolveValidCwd` covers it.
    await expect(
      service.list(AgentKind.Claude, '/definitely/not/here/at/all'),
    ).rejects.toThrow(/does not exist/);
  });

  it('validates the cwd even for an agent that cannot be listed', async () => {
    // Ordering, not just validation: with `resolveValidCwd` below the refusal,
    // a bad cwd is a 400 for claude and a 200 for cursor — and the day cursor
    // gains a listing, folders that used to succeed start failing.
    const registry = {
      for: () =>
        ({
          listMcpServers: vi.fn(),
          getConfig: () => ({
            mcp: { listingUnavailableReason: 'no listing on this CLI yet' },
          }),
        }) as unknown as AgentAdapter,
    } as unknown as AgentAdapterRegistry;
    const service = new AgentMcpService(
      registry,
      new ProcessRegistry(),
      new McpSettingsStore({ file: join(realDir(), 'mcp-settings.json') }),
      { resolveVersionFn: () => Promise.resolve('1') },
    );

    await expect(
      service.list(AgentKind.CursorAgent, 'relative/path'),
    ).rejects.toThrow(/absolute/);
  });

  it('registers the listing child so shutdown can reap its process group', async () => {
    // The listing forks the user's MCP servers; an unregistered child orphans
    // them on shutdown.
    const cwd = realDir();
    const processes = new ProcessRegistry();
    const registerSpy = vi.spyOn(processes, 'register');
    const adapter = {
      getConfig: () => ({
        mcp: {
          listingUnavailableReason: null,
          toggleUnavailableReason: null,
          notInToggleableScopeReason: 'not a project server',
          userDisabledReason: 'you switched it off yourself',
        },
      }),
      listMcpServers: (
        _input: { cwd: string },
        options: {
          onSpawn?: (
            child: unknown,
            spawnInfo: { processGroup: boolean },
          ) => void;
        },
      ) => {
        options.onSpawn?.(
          { pid: 7, kill: () => true, once: () => undefined },
          { processGroup: true },
        );
        return Promise.resolve({ ok: true as const, servers: [server('a')] });
      },
      readMcpFolderFacts: () =>
        Promise.resolve({ projectServers: [], userDisabled: [] }),
    } as unknown as AgentAdapter;
    const service = new AgentMcpService(
      { for: () => adapter } as unknown as AgentAdapterRegistry,
      processes,
      new McpSettingsStore({ file: join(realDir(), 'mcp-settings.json') }),
      { resolveVersionFn: () => Promise.resolve('1') },
    );

    await service.list(AgentKind.Claude, cwd);

    const listing = registerSpy.mock.calls.find(([id]) =>
      String(id).startsWith('mcp:list:'),
    );
    expect(listing).toBeDefined();

    // Registering is not enough — the handle must reap the GROUP. The listing
    // health-checks, so the user's own MCP servers run one generation below
    // it, and a single-PID cancel leaves them running. Asserting only the id
    // keeps passing with the group wiring deleted, which is the pin that
    // actually matters here.
    const kill = vi.spyOn(process, 'kill').mockImplementation((): true => true);
    try {
      (listing?.[1] as { cancel: () => void }).cancel();
      expect(kill).toHaveBeenCalledWith(-7, 'SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });
});

describe('AgentMcpService scope + disabled overlay', () => {
  const projectFacts: AgentMcpFolderFacts = {
    projectServers: ['proj'],
    userDisabled: [],
  };

  it('marks a .mcp.json server as project scope and lets it be switched', async () => {
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('proj')]), {
      facts: projectFacts,
    });

    const [row] = (await service.list(AgentKind.Claude, cwd)).servers;

    expect(row?.scope).toBe('project');
    expect(row?.toggleUnavailableReason).toBeNull();
    expect(row?.disabled).toBe(false);
  });

  it('gives a non-project server no switch, with the reason on the row', async () => {
    // Probe-verified: no settings key disables a user- or local-scope server,
    // so a switch there would move and change nothing.
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('global')]), {
      facts: projectFacts,
    });

    const [row] = (await service.list(AgentKind.Claude, cwd)).servers;

    expect(row?.scope).toBe('other');
    expect(row?.toggleUnavailableReason).not.toBeNull();
  });

  it('gives no switch to a server the user disabled in their own settings', async () => {
    // The CLI UNIONs the disabled lists, so geniro can never pull a name back
    // out of the user's own. Offering the switch would be a control that
    // silently does nothing in the one direction the user would try.
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('proj')]), {
      facts: { projectServers: ['proj'], userDisabled: ['proj'] },
    });

    const [row] = (await service.list(AgentKind.Claude, cwd)).servers;

    expect(row?.scope).toBe('project');
    expect(row?.disabled).toBe(true);
    expect(row?.toggleUnavailableReason).not.toBeNull();
  });

  it('reports a server geniro switched off as disabled', async () => {
    const cwd = realDir();
    const { service, settings } = harness(
      () => Promise.resolve([server('proj')]),
      { facts: projectFacts },
    );
    await settings.setDisabled(AgentKind.Claude, cwd, 'proj', true);

    const [row] = (await service.list(AgentKind.Claude, cwd)).servers;

    expect(row?.disabled).toBe(true);
    // Still switchable — geniro put it there, so geniro can take it back out.
    expect(row?.toggleUnavailableReason).toBeNull();
  });

  it('applies the overlay to a CACHED listing, not just a fresh one', async () => {
    // The disabled set changes independently of the health reading. Decorating
    // only the fresh path would leave a toggled row reading its old state for
    // the rest of the listing's five-minute TTL — the switch would appear to
    // snap back.
    const cwd = realDir();
    const { service, settings, listMcpServers } = harness(
      () => Promise.resolve([server('proj')]),
      { facts: projectFacts },
    );
    await service.list(AgentKind.Claude, cwd);
    await settings.setDisabled(AgentKind.Claude, cwd, 'proj', true);

    const [row] = (await service.list(AgentKind.Claude, cwd)).servers;

    expect(listMcpServers).toHaveBeenCalledTimes(1);
    expect(row?.disabled).toBe(true);
  });

  it('renders every row read-only when the folder facts cannot be read', async () => {
    // Knowing nothing must not be rendered as "everything is toggleable".
    const cwd = realDir();
    // Facts that WOULD make the row toggleable, so the assertions below hold
    // only if the catch's empty-facts fallback is what produced them.
    const { service } = harness(() => Promise.resolve([server('proj')]), {
      facts: projectFacts,
    });
    const adapter = (
      service as unknown as {
        adapters: { for: () => { readMcpFolderFacts: () => Promise<never> } };
      }
    ).adapters.for();
    adapter.readMcpFolderFacts = () => Promise.reject(new Error('EACCES'));

    const [row] = (await service.list(AgentKind.Claude, cwd)).servers;

    expect(row?.scope).toBe('other');
    expect(row?.toggleUnavailableReason).not.toBeNull();
  });
});

describe('AgentMcpService.setEnabled', () => {
  const projectFacts: AgentMcpFolderFacts = {
    projectServers: ['proj'],
    userDisabled: [],
  };

  it('switches a project server off and reports it back as disabled', async () => {
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('proj')]), {
      facts: projectFacts,
    });

    const listing = await service.setEnabled(
      AgentKind.Claude,
      cwd,
      'proj',
      false,
    );

    expect(listing.servers[0]?.disabled).toBe(true);
  });

  it('switches it back on', async () => {
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('proj')]), {
      facts: projectFacts,
    });
    await service.setEnabled(AgentKind.Claude, cwd, 'proj', false);

    const listing = await service.setEnabled(
      AgentKind.Claude,
      cwd,
      'proj',
      true,
    );

    expect(listing.servers[0]?.disabled).toBe(false);
  });

  it('refuses a server that is not project scope', async () => {
    // Writing the setting anyway would persist a toggle the CLI ignores: the
    // user would see the switch move and the next turn would load the server
    // regardless.
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('global')]), {
      facts: projectFacts,
    });

    await expect(
      service.setEnabled(AgentKind.Claude, cwd, 'global', false),
    ).rejects.toThrow();
  });

  it('refuses to re-enable one the user disabled themselves', async () => {
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('proj')]), {
      facts: { projectServers: ['proj'], userDisabled: ['proj'] },
    });

    await expect(
      service.setEnabled(AgentKind.Claude, cwd, 'proj', true),
    ).rejects.toThrow();
  });

  it('refuses for a CLI that cannot be told which servers to load', async () => {
    const cwd = realDir();
    const registry = {
      for: () =>
        ({
          getConfig: () => ({
            mcp: { listingUnavailableReason: 'no listing on this CLI yet' },
          }),
          readMcpFolderFacts: () =>
            Promise.resolve({ projectServers: [], userDisabled: [] }),
        }) as unknown as AgentAdapter,
    } as unknown as AgentAdapterRegistry;
    const service = new AgentMcpService(
      registry,
      new ProcessRegistry(),
      new McpSettingsStore({ file: join(realDir(), 'mcp-settings.json') }),
      { resolveVersionFn: () => Promise.resolve('1') },
    );

    await expect(
      service.setEnabled(AgentKind.CursorAgent, cwd, 'anything', false),
    ).rejects.toThrow();
  });

  it('does not write the setting when it refuses', async () => {
    const cwd = realDir();
    const { service, settings } = harness(
      () => Promise.resolve([server('global')]),
      { facts: projectFacts },
    );

    await service
      .setEnabled(AgentKind.Claude, cwd, 'global', false)
      .catch(() => undefined);

    expect(await settings.disabled(AgentKind.Claude, cwd)).toEqual([]);
  });

  it('keeps one folder’s switch out of another folder’s listing', async () => {
    const dirA = realDir();
    const dirB = realDir();
    const { service } = harness(() => Promise.resolve([server('proj')]), {
      facts: projectFacts,
    });
    await service.setEnabled(AgentKind.Claude, dirA, 'proj', false);

    const inB = await service.list(AgentKind.Claude, dirB);

    expect(inB.servers[0]?.disabled).toBe(false);
  });
});
