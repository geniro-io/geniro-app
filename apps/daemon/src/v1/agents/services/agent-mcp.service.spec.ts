import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
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
  AgentMcpServerHealth,
  AgentSpawnInfo,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentMcpService, BLOCKING_LIST_TIMEOUT_MS } from './agent-mcp.service';
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
  readMcpServerHealth: ReturnType<typeof vi.fn>;
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
  /**
   * Whether a write shows up in the CLI's folder FACTS afterwards. True models
   * claude, whose disabled list is a file geniro reads back; false models
   * cursor, whose only evidence is the next listing — so the service's own
   * record of what it just wrote is all there is.
   */
  recordsFacts?: boolean;
  /**
   * What a single-server dial reports, or null for a CLI that has no such
   * command. Defaults to null — the pre-probe behaviour, so every other case
   * keeps exercising the `unknown` fallback.
   */
  probeHealth?: AgentMcpServerHealth | null;
  /** Make the probe THROW, to drive the after-the-write degrade path. */
  probeThrows?: 'sync' | 'async';
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
    recordsFacts = true,
    probeHealth = null,
    probeThrows,
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
      if (recordsFacts) {
        if (enabled) {
          off.delete(server);
        } else {
          off.add(server);
        }
      }
      return Promise.resolve();
    },
  );
  const readMcpServerHealth = vi.fn(() => {
    if (probeThrows === 'sync') {
      throw new Error('probe blew up before returning a promise');
    }
    if (probeThrows === 'async') {
      return Promise.reject(new Error('probe rejected'));
    }
    return Promise.resolve(probeHealth);
  });
  const adapter = {
    listMcpServers,
    readMcpServerHealth,
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
    readMcpServerHealth,
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

  it('keeps showing the folder’s last servers while a lapsed reading is re-dialled', async () => {
    // The reported wait: the panel opened on a bare spinner for as long as the
    // dial took — 8s against nine servers, up to the CLI's whole 45s deadline
    // when one hangs. The previous reading is not fresher information, but the
    // alternative is NO information for the duration, so it is painted with
    // `pending` saying what it is.
    vi.useFakeTimers();
    const cwd = realDir();
    let calls = 0;
    let releaseRedial!: (servers: AgentMcpServer[]) => void;
    const { service, setNow } = harness(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve([server('codegraph'), server('ticktick')])
        : new Promise<AgentMcpServer[]>((resolve) => {
            releaseRedial = resolve;
          });
    });

    const warm = await service.list(AgentKind.Claude, cwd);
    expect(warm.servers.map((s) => s.name)).toEqual(['codegraph', 'ticktick']);

    // The reading lapses, so the next ask is a cold dial — and this one hangs.
    setNow(1_000 + 6 * 60_000);
    const asked = service.list(AgentKind.Claude, cwd);
    await vi.advanceTimersByTimeAsync(400);
    const stale = await asked;

    expect(stale.pending).toBe(true);
    // The rows the user was looking at a moment ago, rather than an empty
    // panel — this is the whole fix.
    expect(stale.servers.map((s) => s.name)).toEqual(['codegraph', 'ticktick']);

    releaseRedial([server('codegraph')]);
    await vi.advanceTimersByTimeAsync(0);
    const settled = await service.list(AgentKind.Claude, cwd);

    expect(settled.pending).toBe(false);
    expect(settled.servers.map((s) => s.name)).toEqual(['codegraph']);
  });

  it('keeps the rows through a REFRESH too, which is where blanking them stings most', async () => {
    // Reconnect is the press that definitely re-dials. Emptying the list there
    // makes the button that repairs a broken server look like the one that
    // loses the list — and it is pressed precisely when the user is staring at
    // the row they want fixed.
    vi.useFakeTimers();
    const cwd = realDir();
    let calls = 0;
    const { service } = harness(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve([server('codegraph')])
        : new Promise<AgentMcpServer[]>(() => undefined);
    });

    await service.list(AgentKind.Claude, cwd);
    const asked = service.list(AgentKind.Claude, cwd, { refresh: true });
    await vi.advanceTimersByTimeAsync(400);
    const during = await asked;

    expect(during.pending).toBe(true);
    expect(during.servers.map((s) => s.name)).toEqual(['codegraph']);
  });

  it('still shows an empty panel for a folder nothing has ever read', async () => {
    // The stale paint must not invent rows: with no previous reading there is
    // genuinely nothing to show, and `pending` is what keeps that apart from
    // "this folder has no servers".
    vi.useFakeTimers();
    const cwd = realDir();
    const { service } = harness(
      () => new Promise<AgentMcpServer[]>(() => undefined),
    );

    const asked = service.list(AgentKind.Claude, cwd);
    await vi.advanceTimersByTimeAsync(400);
    const first = await asked;

    expect(first.pending).toBe(true);
    expect(first.servers).toEqual([]);
    expect(first.unavailableReason).toBeNull();
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

  it('BOTH shipped adapters list AND switch, so no row is born with a padlock', async () => {
    // Pins the two REAL adapters, not a fixture, so the panel's copy follows
    // the CLIs. This assertion has now been inverted twice, and each time
    // because a declared absence was a measurement nobody re-took: cursor's
    // listing was declared impossible until `cursor-agent mcp list` turned out
    // to exist, and its TOGGLE was declared impossible on the reading that
    // `mcp enable|disable` write a global config — refuted against
    // 2026.08.11-e8db854, where they write `mcp-disabled.json` under the
    // folder's own project key (`cursor-acp.const.ts` carries the capture).
    //
    // A non-null reason on either adapter is what put a padlock on every row
    // of the panel while the user's own Cursor UI offered live switches for
    // the same servers, so both are asserted: reading one field alone would
    // not notice the other regressing.
    const { ClaudeAdapter } = await import('../adapters/claude/claude.adapter');
    const { CursorAcpAdapter } =
      await import('../adapters/cursor-acp/cursor-acp.adapter');

    for (const mcp of [
      new ClaudeAdapter().getConfig().mcp,
      new CursorAcpAdapter().getConfig().mcp,
    ]) {
      expect(mcp.listingUnavailableReason).toBeNull();
      expect(mcp.toggleUnavailableReason).toBeNull();
    }
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

    expect(setMcpServerEnabled).toHaveBeenCalledWith(
      dirA,
      'proj',
      false,
      // The options bag exists for an adapter whose mechanism is a SUBCOMMAND
      // rather than a file: without `onSpawn` that child is never registered,
      // and shutdown cannot reap it. Asserted here rather than in its own case
      // because this is the one call site that has to carry it.
      expect.objectContaining({ onSpawn: expect.any(Function) }),
    );
  });

  describe('a CLI whose disabled state is only visible in the listing', () => {
    // cursor's case. Its `mcp disable` writes state geniro deliberately does not
    // go looking for on disk (the path needs the git root and the right one of
    // the CLI's two project-dir functions), so `readMcpFolderFacts` reports
    // nothing and the ONLY evidence a server is off is the next `mcp list`
    // saying `disabled`. The cached reading was taken BEFORE the write, which is
    // what these two pin.

    it('does not spring the switch back in the answer to the write itself', async () => {
      const cwd = realDir();
      const { service } = harness(() => Promise.resolve([server('a')]), {
        recordsFacts: false,
      });
      // Populates the cache with the pre-write reading — `connected`.
      await service.list(AgentKind.CursorAgent, cwd);

      const after = await service.setEnabled(
        AgentKind.CursorAgent,
        cwd,
        'a',
        false,
      );

      // Without the patch this is `false`: facts know nothing and the cached row
      // still says `connected`, so the route answers that the server the user
      // just switched off is on.
      expect(after.servers[0]?.disabled).toBe(true);
    });

    it('does not spring it back on the next panel open either', async () => {
      // The same staleness, reached the other way — and the worse half: this one
      // lasts the whole TTL, so reopening the panel a minute later contradicts
      // the run. Patching the cache rather than only the answer is what covers
      // it, which is why this is a second case and not an extra assertion.
      const cwd = realDir();
      const { service, listMcpServers } = harness(
        () => Promise.resolve([server('a')]),
        { recordsFacts: false },
      );
      await service.list(AgentKind.CursorAgent, cwd);
      await service.setEnabled(AgentKind.CursorAgent, cwd, 'a', false);

      const reopened = await service.list(AgentKind.CursorAgent, cwd);

      expect(reopened.servers[0]?.disabled).toBe(true);
      // And it must be the CHEAP path: charging the click a fresh cold dial of
      // every server in the folder is what patching instead of evicting avoids.
      expect(listMcpServers).toHaveBeenCalledTimes(1);
    });

    it('asks the CLI about that ONE server when switching it on, and uses the answer', async () => {
      // The whole reason `readMcpServerHealth` exists. `unknown` was honest but
      // useless — a row with no health and no Sign in control — and re-dialling
      // the FOLDER to fix it would launch every server in it. One server's dial
      // costs 1.2–3.7s against 4–9s (cursor, measured), so the answer is asked
      // for rather than assumed.
      const cwd = realDir();
      const { service, readMcpServerHealth } = harness(
        () => Promise.resolve([server('a')]),
        {
          recordsFacts: false,
          probeHealth: { status: 'needs_auth', detail: null },
        },
      );
      await service.list(AgentKind.CursorAgent, cwd);
      await service.setEnabled(AgentKind.CursorAgent, cwd, 'a', false);

      const back = await service.setEnabled(
        AgentKind.CursorAgent,
        cwd,
        'a',
        true,
      );

      // `needs_auth` and not `unknown`: this is the status the panel draws a
      // Sign in button for, and it is the majority state of a real listing.
      expect(back.servers[0]?.status).toBe('needs_auth');
      expect(back.servers[0]?.disabled).toBe(false);
      expect(readMcpServerHealth).toHaveBeenCalledWith(
        { cwd, server: 'a' },
        expect.objectContaining({ onSpawn: expect.any(Function) }),
      );
    });

    it('does NOT dial when switching a server off', async () => {
      // Nothing to verify: the CLI reports a switched-off server as `disabled`,
      // and dialling a server in order to stop using it would launch the very
      // process the user just asked not to run.
      const cwd = realDir();
      const { service, readMcpServerHealth } = harness(
        () => Promise.resolve([server('a')]),
        {
          recordsFacts: false,
          probeHealth: { status: 'connected', detail: null },
        },
      );
      // Populates the cache, so the row below is the PATCHED one rather than a
      // fresh dial's — otherwise this would assert nothing about the patch.
      await service.list(AgentKind.CursorAgent, cwd);

      const off = await service.setEnabled(
        AgentKind.CursorAgent,
        cwd,
        'a',
        false,
      );

      expect(readMcpServerHealth).not.toHaveBeenCalled();
      expect(off.servers[0]?.status).toBe('disabled');
    });

    for (const throws of ['sync', 'async'] as const) {
      it(`still reports the toggle that LANDED when the probe throws (${throws})`, async () => {
        // The probe runs after a write that already took effect. Letting its
        // failure reach the caller would report a switch that moved as one that
        // did not — and the user would flip it back, undoing a change that had
        // worked. The sync case needs its own run because a bare call would
        // bypass the `.catch` entirely.
        const cwd = realDir();
        const { service } = harness(() => Promise.resolve([server('a')]), {
          recordsFacts: false,
          probeThrows: throws,
        });
        await service.list(AgentKind.CursorAgent, cwd);
        await service.setEnabled(AgentKind.CursorAgent, cwd, 'a', false);

        const back = await service.setEnabled(
          AgentKind.CursorAgent,
          cwd,
          'a',
          true,
        );

        expect(back.servers[0]?.disabled).toBe(false);
        // Degraded to the honest placeholder, not to a guess.
        expect(back.servers[0]?.status).toBe('unknown');
      });
    }

    it('states an ON server’s health as unknown rather than inventing one', async () => {
      // Asymmetric on purpose. Switching a server OFF makes the CLI report
      // exactly `disabled`; switching one ON leaves its health whatever a dial
      // would find, and nothing has dialled it. `connected` here would be the
      // panel asserting a server works because a switch moved.
      const cwd = realDir();
      const { service } = harness(() => Promise.resolve([server('a')]), {
        recordsFacts: false,
      });
      await service.list(AgentKind.CursorAgent, cwd);
      await service.setEnabled(AgentKind.CursorAgent, cwd, 'a', false);

      const back = await service.setEnabled(
        AgentKind.CursorAgent,
        cwd,
        'a',
        true,
      );

      expect(back.servers[0]?.disabled).toBe(false);
      expect(back.servers[0]?.status).toBe('unknown');
      // The reason belonged to the status it explained.
      expect(back.servers[0]?.detail).toBeNull();
    });
  });

  it('registers the child of a toggle that reaches the CLI, so shutdown can reap it', async () => {
    // The `onSpawn` above is only half the obligation — a hand-off nothing acts
    // on is the same as none. This drives the real seam: the adapter calls
    // `onSpawn` the way `CursorAcpAdapter.setMcpServerEnabled` does through
    // `runCommand`, and the registry must then hold a handle.
    const cwd = realDir();
    const processes = new ProcessRegistry();
    const child = new EventEmitter() as unknown as ChildProcess;
    const setMcpServerEnabled = vi.fn(
      (
        _cwd: string,
        _server: string,
        _enabled: boolean,
        options: {
          onSpawn?: (c: ChildProcess, i: AgentSpawnInfo) => void;
        } = {},
      ) => {
        options.onSpawn?.(child, { processGroup: false });
        return Promise.resolve();
      },
    );
    const adapter = {
      listMcpServers: () =>
        Promise.resolve({ ok: true as const, servers: [server('a')] }),
      getConfig: () => ({
        mcp: {
          listingUnavailableReason: null,
          toggleUnavailableReason: null,
          userDisabledReason: 'you switched it off yourself',
        },
      }),
      readMcpFolderFacts: () =>
        Promise.resolve({ disabled: [], lockedOff: [] }),
      setMcpServerEnabled,
    } as unknown as AgentAdapter;
    const service = new AgentMcpService(
      { for: () => adapter } as unknown as AgentAdapterRegistry,
      processes,
      new AgentVersionService(),
      emptyHarvest(),
      {
        resolveVersionFn: () => Promise.resolve('1.0.0'),
        folderlessDir: join(realDir(), 'folderless'),
      },
    );

    const registered = vi.spyOn(processes, 'register');

    await service.setEnabled(AgentKind.CursorAgent, cwd, 'a', false);

    // The id captured from the real call, then read back off the registry: the
    // spy alone would pass on a `register` that threw the handle away, and
    // `activeCount` alone could not tell this child from another spec's.
    expect(registered).toHaveBeenCalledTimes(1);
    const id = registered.mock.calls[0]?.[0] ?? '';
    expect(id).toMatch(/^mcp:toggle:/);
    expect(processes.has(id)).toBe(true);
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

/**
 * Who may hold a socket open across a cold dial, and who may not.
 *
 * The panel's read is answered inside the first-paint budget and the dial
 * finishes behind it, so it must inherit the ADAPTER's deadline — which is
 * sized for a genuinely cold dial of the user's own servers (claude: two
 * minutes). Capping it here is what produced "could not read MCP servers —
 * claude did not answer" on a listing that was merely slow.
 *
 * The toggle is the opposite: its whole answer IS the resulting listing, so it
 * awaits the dial inside the request and must give up before the renderer's own
 * 60s route timeout arrives in front of it.
 */
describe('cold-dial deadlines', () => {
  it('leaves the panel read on the adapter’s own deadline', async () => {
    const cwd = realDir();
    const { service, listMcpServers } = harness(() =>
      Promise.resolve([server('a')]),
    );

    await service.list(AgentKind.Claude, cwd);

    // Not "some other number" — ABSENT, so `listMcpServers` falls through to
    // its own `options.timeoutMs ?? CLAUDE_MCP_LIST_TIMEOUT_MS` default.
    const [, options] = listMcpServers.mock.calls[0] as [
      unknown,
      { timeoutMs?: number } | undefined,
    ];
    expect(options?.timeoutMs).toBeUndefined();
  });

  it('caps a toggle’s blocking read so the request cannot outlive the client', async () => {
    const cwd = realDir();
    const { service, listMcpServers } = harness(() =>
      Promise.resolve([server('a')]),
    );

    // No prior `list`, so the cache is cold and the toggle's own read really
    // does dial — which is the only path this cap governs.
    await service.setEnabled(AgentKind.Claude, cwd, 'a', false);

    const [, options] = listMcpServers.mock.calls[0] as [
      unknown,
      { timeoutMs?: number } | undefined,
    ];
    expect(options?.timeoutMs).toBe(BLOCKING_LIST_TIMEOUT_MS);
  });
});
