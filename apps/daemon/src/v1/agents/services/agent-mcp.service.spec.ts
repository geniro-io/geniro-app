import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentKind } from '../../runs/runs.types';
import type {
  AgentMcpFolderFacts,
  AgentMcpServer,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentMcpService } from './agent-mcp.service';
import { AgentVersionService } from './agent-version.service';
import { McpHarvestStore } from './mcp-harvest.store';
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

/**
 * A harvest store nothing has ever reported into, on a throwaway file.
 *
 * The default file lives under the real userData dir, so a spec that let it
 * through would read and WRITE the user's own harvest. Empty is also the right
 * default for these specs: with no harvested answer the service falls through
 * to asking the adapter, which is the path they are all about — the harvest
 * short-circuit gets its own tests below.
 */
function emptyHarvest(): McpHarvestStore {
  return new McpHarvestStore({ file: join(realDir(), 'mcp-harvest.json') });
}

afterEach(() => {
  // Before the dir sweep: a spec that took fake timers must not leave them for
  // the next one, which would then hang on the first-paint budget.
  vi.useRealTimers();
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
  harvest: McpHarvestStore;
  listMcpServers: ReturnType<typeof vi.fn>;
  readMcpFolderFacts: ReturnType<typeof vi.fn>;
  setNow: (ms: number) => void;
  setMcpServerEnabled: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  version?: string | null;
  /** What the CLI's own config files say — defaults to knowing nothing. */
  facts?: AgentMcpFolderFacts;
  /**
   * A blanket "this CLI cannot be switched at all" reason. Defaults to null —
   * the toggleable CLI. Set it to reach the other branch of `composeListing`.
   */
  toggleUnavailableReason?: string | null;
  /**
   * A harvest store already holding a turn's report. Defaults to empty, which
   * is what sends every other test down the ask-the-adapter path.
   */
  harvest?: McpHarvestStore;
}

function harness(
  impl: (input: {
    cwd: string;
    configDir?: string | null;
  }) => Promise<AgentMcpServer[]>,
  options: HarnessOptions = {},
): Harness {
  const {
    version = '2.1.220',
    facts,
    toggleUnavailableReason = null,
    harvest = emptyHarvest(),
  } = options;
  // The fixtures speak in plain server arrays; the adapter contract is the
  // discriminated result, so wrap here rather than in every case.
  const listMcpServers = vi.fn(
    (input: { cwd: string; configDir?: string | null }) =>
      impl(input).then((servers) => ({ ok: true as const, servers })),
  );
  // The adapter's OWN state, mutated by `setMcpServerEnabled` — the same
  // relationship the real one has with the CLI's config file, so a toggle the
  // service refuses cannot silently look like it landed.
  const off = new Set(facts?.disabled ?? []);
  const readMcpFolderFacts = vi.fn(() =>
    Promise.resolve({
      disabled: [...off],
      lockedOff: facts?.lockedOff ?? [],
    }),
  );
  const setMcpServerEnabled = vi.fn(
    (_cwd: string, server: string, enabled: boolean) => {
      if (enabled) {
        off.delete(server);
      } else {
        off.add(server);
      }
      return Promise.resolve();
    },
  );
  const adapter = {
    listMcpServers,
    getConfig: () => ({
      mcp: {
        listingUnavailableReason: null,
        toggleUnavailableReason,
        userDisabledReason: 'you switched it off yourself',
      },
    }),
    readMcpFolderFacts,
    setMcpServerEnabled,
  } as unknown as AgentAdapter;
  const registry = {
    for: () => adapter,
  } as unknown as AgentAdapterRegistry;
  let now = 1_000;
  const service = new AgentMcpService(
    registry,
    new ProcessRegistry(),
    new AgentVersionService(),
    harvest,
    {
      now: () => now,
      resolveVersionFn: () => Promise.resolve(version),
      // Never the default: that resolves under the real userData dir, so a
      // folder-independent read in a spec would create a directory in the
      // user's own data.
      folderlessDir: join(realDir(), 'folderless'),
    },
  );
  return {
    service,
    harvest,
    listMcpServers,
    readMcpFolderFacts,
    setMcpServerEnabled,
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

  it('does NOT serve one config directory’s rows for another', async () => {
    // The configDir half of the key, and the whole reason the dimension
    // exists: two agent nodes pointed at different plugin directories are
    // MEANT to differ, so sharing a cache entry would show one node's tools
    // under the other's name — wrong, not merely stale.
    const cwd = realDir();
    const pluginA = realDir();
    const pluginB = realDir();
    const { service, listMcpServers } = harness((input) =>
      Promise.resolve([
        server(input.configDir === pluginA ? 'from-a' : 'from-b'),
      ]),
    );

    const a = await service.list(AgentKind.Claude, cwd, {
      configDir: pluginA,
    });
    const b = await service.list(AgentKind.Claude, cwd, {
      configDir: pluginB,
    });

    expect(a.servers.map((s) => s.name)).toEqual(['from-a']);
    expect(b.servers.map((s) => s.name)).toEqual(['from-b']);
    expect(listMcpServers).toHaveBeenCalledTimes(2);
  });

  it('does NOT serve a plugin-less listing for one carrying a plugin', async () => {
    // The absent case specifically: `undefined` and a real path must not
    // collapse onto one key, or the inspector's first node would poison the
    // panel's own folder listing.
    const cwd = realDir();
    const plugin = realDir();
    const { service, listMcpServers } = harness((input) =>
      Promise.resolve([server(input.configDir ? 'with-plugin' : 'bare')]),
    );

    const bare = await service.list(AgentKind.Claude, cwd);
    const withPlugin = await service.list(AgentKind.Claude, cwd, {
      configDir: plugin,
    });

    expect(bare.servers.map((s) => s.name)).toEqual(['bare']);
    expect(withPlugin.servers.map((s) => s.name)).toEqual(['with-plugin']);
    expect(listMcpServers).toHaveBeenCalledTimes(2);
  });

  it('REFUSES an unusable config directory instead of asking the CLI', async () => {
    // The whole point of validating: the CLI ignores a bad --plugin-dir
    // silently (exit 0, "No MCP servers configured"), so passing it through
    // would render as "this node has no MCP servers" — indistinguishable from
    // the truth. Delete the guard in `list` and this is what stops being true.
    const { service, listMcpServers } = harness(() =>
      Promise.resolve([server('a')]),
    );

    await expect(
      service.list(AgentKind.Claude, realDir(), {
        configDir: join(realDir(), 'no-such-plugin'),
      }),
    ).rejects.toMatchObject({ errorCode: 'INVALID_CONFIG_DIR' });
    // ...and it never reached the CLI, so nothing was health-checked.
    expect(listMcpServers).not.toHaveBeenCalled();
  });

  it('refuses a RELATIVE config directory', async () => {
    const { service, listMcpServers } = harness(() =>
      Promise.resolve([server('a')]),
    );

    await expect(
      service.list(AgentKind.Claude, realDir(), { configDir: 'plugins/x' }),
    ).rejects.toMatchObject({ errorCode: 'INVALID_CONFIG_DIR' });
    expect(listMcpServers).not.toHaveBeenCalled();
  });

  it('answers a null cwd in its own empty folder, not the daemon’s', async () => {
    // The graph builder has no folder. A null cwd must still reach the
    // adapter with a REAL directory — one geniro owns and keeps empty, so the
    // answer is the folder-independent set rather than whatever project
    // config happens to sit in the daemon's own working directory.
    const seen: string[] = [];
    const { service } = harness((input) => {
      seen.push(input.cwd);
      return Promise.resolve([server('global')]);
    });

    const result = await service.list(AgentKind.Claude, null);

    expect(result.servers.map((s) => s.name)).toEqual(['global']);
    expect(seen).toHaveLength(1);
    expect(isAbsolute(seen[0]!)).toBe(true);
    expect(seen[0]).not.toBe(process.cwd());
    // The directory must EXIST — asserting only the absence of a `.mcp.json`
    // would also hold for a path that was never created, so deleting the
    // mkdirSync would stay green while production spawned the CLI with an
    // ENOENT cwd.
    expect(existsSync(seen[0]!)).toBe(true);
    expect(statSync(seen[0]!).isDirectory()).toBe(true);
    // And it really is empty — a project `.mcp.json` there would leak one
    // folder's servers into every builder listing.
    expect(existsSync(join(seen[0]!, '.mcp.json'))).toBe(false);
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
            Promise.resolve({ disabled: [], lockedOff: [] }),
        } as unknown as AgentAdapter;
      },
    } as unknown as AgentAdapterRegistry;
    const service = new AgentMcpService(
      registry,
      new ProcessRegistry(),
      new AgentVersionService(),
      emptyHarvest(),
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
            Promise.resolve({ disabled: [], lockedOff: [] }),
        }) as unknown as AgentAdapter,
    } as unknown as AgentAdapterRegistry;
    let version = '2.1.220';
    const service = new AgentMcpService(
      registry,
      new ProcessRegistry(),
      new AgentVersionService(),
      emptyHarvest(),
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
    await service.list(AgentKind.Claude, cwd, { refresh: true });

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

  it('answers a slow cold dial with `pending` instead of holding the request open', async () => {
    // The cold read STARTS the user's own MCP servers to health-check them —
    // 6.7s here against nine, bounded only by the slowest, up to the CLI's
    // whole 45s listing timeout. Awaiting that gave the panel a spinner and
    // nothing else, and gave it to a cursor scope EVERY time: the `mcp_servers`
    // event has one producer (claude's `system/init`), so no cursor folder ever
    // has a harvest to answer from.
    vi.useFakeTimers();
    const cwd = realDir();
    let release!: (servers: AgentMcpServer[]) => void;
    const { service } = harness(
      () =>
        new Promise<AgentMcpServer[]>((resolve) => {
          release = resolve;
        }),
    );

    const asked = service.list(AgentKind.Claude, cwd);
    await vi.advanceTimersByTimeAsync(400);
    const first = await asked;

    expect(first.pending).toBe(true);
    expect(first.servers).toEqual([]);
    // Empty rows here are NOT "this folder has no servers" — `pending` is what
    // keeps those two apart on the wire.
    expect(first.unavailableReason).toBeNull();

    // The dial kept going behind the answer; the next ask collects it.
    release([server('sentry')]);
    await vi.advanceTimersByTimeAsync(0);
    const second = await service.list(AgentKind.Claude, cwd);

    expect(second.pending).toBe(false);
    expect(second.servers.map((s) => s.name)).toEqual(['sentry']);
  });

  it('hands the next ask the failure the deferred dial produced', async () => {
    // A dial that misses the budget finishes with nobody awaiting it, and a
    // FAILED one is deliberately never cached — so its verdict has to survive
    // to the ask that comes back for it, or it is lost outright. Lost, the
    // caller is told `pending` again, is never told what went wrong, and its
    // retry starts yet another cold dial of the user's own MCP servers.
    vi.useFakeTimers();
    const cwd = realDir();
    let fail!: (err: Error) => void;
    const { service } = harness(
      () =>
        new Promise<AgentMcpServer[]>((_resolve, reject) => {
          fail = reject;
        }),
    );

    const asked = service.list(AgentKind.Claude, cwd);
    await vi.advanceTimersByTimeAsync(400);
    expect((await asked).pending).toBe(true);

    // The dial ends badly, well after the request that started it was answered.
    fail(new Error('mcp list timed out'));
    await vi.advanceTimersByTimeAsync(0);

    const collected = service.list(AgentKind.Claude, cwd);
    await vi.advanceTimersByTimeAsync(400);
    const listing = await collected;

    expect(listing.pending).toBe(false);
    expect(listing.unavailableReason).toBe(
      'could not read MCP servers — mcp list timed out',
    );
  });

  it('serves a dial that beats the budget in one round trip', async () => {
    // The reason this is a budget and not an immediate `pending`: most folders
    // are not slow, and answering "ask again" to a read that had already
    // finished would cost a second round trip for nothing.
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('quick')]));

    const listing = await service.list(AgentKind.Claude, cwd);

    expect(listing.pending).toBe(false);
    expect(listing.servers.map((s) => s.name)).toEqual(['quick']);
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

    const first = service.list(AgentKind.Claude, cwd, { refresh: true });
    const second = service.list(AgentKind.Claude, cwd, { refresh: true });
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
    const after = await service.list(AgentKind.Claude, cwd, { refresh: true });

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
    // The thrown message is CARRIED, not replaced. This arm only fires when an
    // adapter broke its contract, which is exactly when the flat sentence
    // leaves nobody able to tell a missing binary from a deadline — the panel
    // is the only place it surfaces and it has room for the line.
    expect(result.unavailableReason).toContain('boom');
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
      new AgentVersionService(),
      emptyHarvest(),
      { resolveVersionFn: () => Promise.resolve('1') },
    );

    await expect(service.list(AgentKind.CursorAgent, cwd)).resolves.toEqual({
      servers: [],
      unavailableReason: 'no listing on this CLI yet',
      // A settled refusal, not a read in progress — there is nothing to wait
      // for, so telling the caller to ask again would loop it forever.
      pending: false,
    });
    expect(listMcpServers).not.toHaveBeenCalled();
  });

  it('BOTH shipped adapters now list, and only cursor declares the toggle absent', async () => {
    // Pins the two REAL adapters, not a fixture, so the panel's copy follows
    // the CLIs. This assertion was inverted in milestone 4: cursor used to
    // declare its listing unavailable, and `cursor-agent mcp list` turned out
    // to exist. What did NOT change is the toggle — `mcp enable|disable` write
    // cursor's global config, which this feature will not touch — so a cursor
    // row still carries a reason for having no switch, and losing that reason
    // would put a dead control on every one of them.
    const { ClaudeAdapter } = await import('../adapters/claude/claude.adapter');
    const { CursorAcpAdapter } =
      await import('../adapters/cursor-acp/cursor-acp.adapter');

    const claudeMcp = new ClaudeAdapter().getConfig().mcp;
    expect(claudeMcp.listingUnavailableReason).toBeNull();
    // "ONLY cursor" is half the claim, so claude's null is asserted too: a
    // blanket reason appearing here would strip the switch off every claude
    // row, and reading only cursor's field would not notice.
    expect(claudeMcp.toggleUnavailableReason).toBeNull();
    const cursorMcp = new CursorAcpAdapter().getConfig().mcp;
    expect(cursorMcp.listingUnavailableReason).toBeNull();
    expect(cursorMcp.toggleUnavailableReason).toEqual(
      expect.stringContaining('cursor-agent'),
    );
  });

  it('marks a row the CLI itself reported as switched off, even where geniro cannot switch', async () => {
    // `cursor-agent mcp disable` is real and reachable, and the wire flag asks
    // whether the NEXT TURN will leave the server out — whoever switched it
    // off. Hardcoding `false` for a CLI geniro cannot toggle renders a
    // switched-off server as on, which is the panel contradicting the run.
    const cwd = realDir();
    const { service } = harness(
      () =>
        Promise.resolve([
          {
            name: 'off-srv',
            target: null,
            transport: null,
            status: 'disabled' as const,
            detail: null,
          },
        ]),
      { toggleUnavailableReason: 'cursor-agent cannot switch these' },
    );

    const listing = await service.list(AgentKind.CursorAgent, cwd);

    expect(listing.servers[0]?.disabled).toBe(true);
    expect(listing.servers[0]?.toggleUnavailableReason).toBe(
      'cursor-agent cannot switch these',
    );
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
      new AgentVersionService(),
      emptyHarvest(),
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
      new AgentVersionService(),
      emptyHarvest(),
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
  const nothingOff: AgentMcpFolderFacts = { disabled: [], lockedOff: [] };

  it('lets a server be switched, whatever scope defined it', async () => {
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('global')]), {
      facts: nothingOff,
    });

    const [row] = (await service.list(AgentKind.Claude, cwd)).servers;

    expect(row?.toggleUnavailableReason).toBeNull();
    expect(row?.disabled).toBe(false);
  });

  it('gives no switch to a server the user turned down themselves', async () => {
    // The CLI UNIONs the rejection lists, so geniro can never pull a name back
    // out of the user's own. Offering the switch would be a control that
    // silently does nothing in the one direction the user would try.
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('proj')]), {
      facts: { disabled: [], lockedOff: ['proj'] },
    });

    const [row] = (await service.list(AgentKind.Claude, cwd)).servers;

    expect(row?.disabled).toBe(true);
    expect(row?.toggleUnavailableReason).not.toBeNull();
  });

  it('reports a server the config has switched off as disabled', async () => {
    // The LISTING cannot see it — `claude mcp list` reports a disabled server
    // as though it were live (probe-verified) — so the row's state comes from
    // the config's own list, not from the health reading.
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('proj')]), {
      facts: { disabled: ['proj'], lockedOff: [] },
    });

    const [row] = (await service.list(AgentKind.Claude, cwd)).servers;

    expect(row?.disabled).toBe(true);
    // Still switchable — it was switched off through this same list.
    expect(row?.toggleUnavailableReason).toBeNull();
  });

  it('applies the overlay to a CACHED listing, not just a fresh one', async () => {
    // The disabled set changes independently of the health reading. Decorating
    // only the fresh path would leave a toggled row reading its old state for
    // the rest of the listing's five-minute TTL — the switch would appear to
    // snap back.
    const cwd = realDir();
    const { service, listMcpServers } = harness(
      () => Promise.resolve([server('proj')]),
      { facts: nothingOff },
    );
    await service.list(AgentKind.Claude, cwd);
    await service.setEnabled(AgentKind.Claude, cwd, 'proj', false);

    const [row] = (await service.list(AgentKind.Claude, cwd)).servers;

    expect(listMcpServers).toHaveBeenCalledTimes(1);
    expect(row?.disabled).toBe(true);
  });

  it('renders every row read-only when the folder facts cannot be read', async () => {
    // Knowing nothing must not be rendered as "everything is toggleable".
    const cwd = realDir();
    // Facts that WOULD make the row toggleable, so the assertions below hold
    // only if the catch is what produced them.
    const { service } = harness(() => Promise.resolve([server('proj')]), {
      facts: nothingOff,
    });
    const adapter = (
      service as unknown as {
        adapters: { for: () => { readMcpFolderFacts: () => Promise<never> } };
      }
    ).adapters.for();
    adapter.readMcpFolderFacts = () => Promise.reject(new Error('EACCES'));

    const [row] = (await service.list(AgentKind.Claude, cwd)).servers;

    expect(row?.scope).toBe('unknown');
    expect(row?.toggleUnavailableReason).not.toBeNull();
  });
});

describe('AgentMcpService.setEnabled', () => {
  const nothingOff: AgentMcpFolderFacts = { disabled: [], lockedOff: [] };

  it('switches a server off and reports it back as disabled', async () => {
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('proj')]), {
      facts: nothingOff,
    });

    const listing = await service.setEnabled(
      AgentKind.Claude,
      cwd,
      'proj',
      false,
    );

    expect(listing.servers[0]?.disabled).toBe(true);
  });

  it('reports the switch that landed even when the rows come from a harvest', async () => {
    // Every other case here runs on an EMPTY harvest, so they all take the
    // ask-the-adapter path. With one present the short-circuit sits above that
    // ask, and the rows it returns were captured BEFORE the write — a turn
    // reported the server `connected`, and nothing re-dials it here. What
    // corrects them is the folder-facts overlay, which is read fresh on every
    // exit path; without that, a toggle would answer with its own stale
    // "connected, enabled" row and the switch would snap back.
    const cwd = realDir();
    const harvest = emptyHarvest();
    harvest.record('claude', cwd, null, [server('proj')]);
    const { service, listMcpServers } = harness(
      () => Promise.resolve([server('proj')]),
      { facts: nothingOff, harvest },
    );

    const listing = await service.setEnabled(
      AgentKind.Claude,
      cwd,
      'proj',
      false,
    );

    expect(listMcpServers).not.toHaveBeenCalled();
    expect(listing.servers[0]?.disabled).toBe(true);
    expect(listing.pending).toBe(false);
  });

  it('re-reads the folder AFTER the write, so the row is the state that landed', async () => {
    // The write changes exactly the half the facts report, so answering from
    // the pre-write copy would render the state the user just left — a switch
    // that visibly snaps back.
    const cwd = realDir();
    const { service, readMcpFolderFacts } = harness(
      () => Promise.resolve([server('proj')]),
      { facts: nothingOff },
    );

    const listing = await service.setEnabled(
      AgentKind.Claude,
      cwd,
      'proj',
      false,
    );

    expect(readMcpFolderFacts.mock.calls.length).toBeGreaterThan(1);
    expect(listing.servers[0]).toMatchObject({
      name: 'proj',
      disabled: true,
      toggleUnavailableReason: null,
    });
  });

  it('switches it back on', async () => {
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('proj')]), {
      facts: nothingOff,
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

  it('reports a failed write as a refusal instead of a silent success', async () => {
    // The adapter reaches the user's own config and a real lock. A write that
    // could not be taken must not come back as a listing claiming it landed.
    const cwd = realDir();
    const { service, setMcpServerEnabled } = harness(
      () => Promise.resolve([server('proj')]),
      { facts: nothingOff },
    );
    setMcpServerEnabled.mockRejectedValueOnce(new Error('ELOCKED'));

    await expect(
      service.setEnabled(AgentKind.Claude, cwd, 'proj', false),
    ).rejects.toThrow(/ELOCKED/);
  });

  it('refuses to re-enable one the user turned down themselves', async () => {
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('proj')]), {
      facts: { disabled: [], lockedOff: ['proj'] },
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
            Promise.resolve({ disabled: [], lockedOff: [] }),
        }) as unknown as AgentAdapter,
    } as unknown as AgentAdapterRegistry;
    const service = new AgentMcpService(
      registry,
      new ProcessRegistry(),
      new AgentVersionService(),
      emptyHarvest(),
      { resolveVersionFn: () => Promise.resolve('1') },
    );

    await expect(
      service.setEnabled(AgentKind.CursorAgent, cwd, 'anything', false),
    ).rejects.toThrow();
  });

  it('does not reach the adapter when it refuses', async () => {
    const cwd = realDir();
    const { service, setMcpServerEnabled } = harness(
      () => Promise.resolve([server('proj')]),
      { facts: { disabled: [], lockedOff: ['proj'] } },
    );

    await service
      .setEnabled(AgentKind.Claude, cwd, 'proj', true)
      .catch(() => undefined);

    expect(setMcpServerEnabled).not.toHaveBeenCalled();
  });

  it('hands the adapter the folder, so one folder’s switch is only its own', async () => {
    const dirA = realDir();
    const { service, setMcpServerEnabled } = harness(
      () => Promise.resolve([server('proj')]),
      { facts: nothingOff },
    );

    await service.setEnabled(AgentKind.Claude, dirA, 'proj', false);

    expect(setMcpServerEnabled).toHaveBeenCalledWith(dirA, 'proj', false);
  });
});

describe('the turn harvest', () => {
  /** A harvest store already holding what a turn reported for `cwd`. */
  function harvestOf(cwd: string, servers: AgentMcpServer[]): McpHarvestStore {
    const store = new McpHarvestStore({
      file: join(realDir(), 'mcp-harvest.json'),
    });
    store.record(AgentKind.Claude, cwd, null, servers);
    return store;
  }

  const harvested = (
    name: string,
    status: AgentMcpServer['status'] = 'connected',
  ): AgentMcpServer => ({
    name,
    target: null,
    transport: null,
    status,
    detail: null,
  });

  it('answers from a turn’s report WITHOUT dialling the servers', async () => {
    // THE point of the feature. Asking the adapter means `claude mcp list`,
    // which health-checks by starting every configured server — 6.7s measured,
    // and bounded by the slowest one. A turn already said this, for free.
    const cwd = realDir();
    const { service, listMcpServers } = harness(
      () => Promise.reject(new Error('the CLI must not be asked')),
      { harvest: harvestOf(cwd, [harvested('codegraph')]) },
    );

    const listing = await service.list(AgentKind.Claude, cwd);

    expect(listMcpServers).not.toHaveBeenCalled();
    expect(listing.servers.map((s) => s.name)).toEqual(['codegraph']);
  });

  it('still dials when the user asks for a refresh', async () => {
    // Reconnect is the ONE way a settled status is re-read: init reports the
    // state at turn start and nothing later updates it, so a `pending` server
    // stays pending in the harvest forever. Serving the harvest here would
    // make the button inert.
    const cwd = realDir();
    const { service, listMcpServers } = harness(
      () => Promise.resolve([server('dialled')]),
      { harvest: harvestOf(cwd, [harvested('codegraph', 'pending')]) },
    );

    const listing = await service.list(AgentKind.Claude, cwd, {
      refresh: true,
    });

    expect(listMcpServers).toHaveBeenCalledTimes(1);
    expect(listing.servers.map((s) => s.name)).toEqual(['dialled']);
  });

  it('prefers a FRESH dialled reading over the harvest', async () => {
    // The harvest is the floor, never the ceiling: a verified reading carries
    // each server's command line and a settled status, so it wins while it is
    // still fresh.
    const cwd = realDir();
    const { service } = harness(() => Promise.resolve([server('dialled')]), {
      harvest: harvestOf(cwd, [harvested('codegraph')]),
    });

    await service.list(AgentKind.Claude, cwd, { refresh: true });
    const listing = await service.list(AgentKind.Claude, cwd);

    expect(listing.servers.map((s) => s.name)).toEqual(['dialled']);
  });

  it('fills a harvested row’s command line from a LAPSED reading', async () => {
    // Neither source is a superset: the harvest has the fresher status, the
    // old listing has the `target` init never reports — and `target` is what
    // the panel's row tooltip shows.
    const cwd = realDir();
    const { service, setNow } = harness(
      () => Promise.resolve([server('codegraph')]),
      { harvest: harvestOf(cwd, [harvested('codegraph', 'failed')]) },
    );

    await service.list(AgentKind.Claude, cwd, { refresh: true });
    setNow(1_000 + 10 * 60_000);
    const [row] = (await service.list(AgentKind.Claude, cwd)).servers;

    expect(row).toMatchObject({
      name: 'codegraph',
      target: 'node codegraph.js',
      transport: 'stdio',
      // The harvest's own, not the lapsed reading's `connected`.
      status: 'failed',
    });
  });

  it('does not resurrect a server the turn no longer loads', async () => {
    // A server missing from the turn's report is genuinely gone — switched off
    // or removed. Merging the old listing in as a union would put it back on
    // screen, with a switch, after the user turned it off.
    const cwd = realDir();
    const { service, setNow } = harness(
      () => Promise.resolve([server('kept'), server('removed')]),
      { harvest: harvestOf(cwd, [harvested('kept')]) },
    );

    await service.list(AgentKind.Claude, cwd, { refresh: true });
    setNow(1_000 + 10 * 60_000);
    const listing = await service.list(AgentKind.Claude, cwd);

    expect(listing.servers.map((s) => s.name)).toEqual(['kept']);
  });

  it('drops a lapsed failure reason once the status has changed', async () => {
    // A `detail` explains a STATUS. Pinning yesterday's failure reason under
    // today's `connected` row would state a problem that no longer exists —
    // and the panel renders that string to the user verbatim.
    const cwd = realDir();
    const { service, setNow } = harness(
      () =>
        Promise.resolve([
          {
            ...server('flaky'),
            status: 'failed' as const,
            detail: 'ECONNREFUSED',
          },
        ]),
      { harvest: harvestOf(cwd, [harvested('flaky', 'connected')]) },
    );

    await service.list(AgentKind.Claude, cwd, { refresh: true });
    setNow(1_000 + 10 * 60_000);
    const [row] = (await service.list(AgentKind.Claude, cwd)).servers;

    expect(row).toMatchObject({ status: 'connected', detail: null });
    // ...but the command line, which does not depend on the status, survives.
    expect(row?.target).toBe('node flaky.js');
  });
});
