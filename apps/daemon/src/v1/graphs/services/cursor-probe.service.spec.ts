import type { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import type { RuntimeInfo } from '../../../auth/runtime';
import type {
  AgentEvent,
  AgentTurnInput,
} from '../../agents/adapters/adapter.types';
import type { CursorAdapter } from '../../agents/adapters/cursor/cursor.adapter';
import { ProcessRegistry } from '../../agents/services/process-registry';
import {
  type CursorProbeOptions,
  CursorProbeService,
} from './cursor-probe.service';

const RUNTIME: RuntimeInfo = {
  token: 'launch',
  version: '9.9.9',
  startedAt: 0,
  port: 4870,
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cursor-probe-spec-'));
  roots.push(root);
  return root;
}

/**
 * A fake cursor-agent: reads the mcp.json the probe wrote into its temp cwd
 * (exactly like the real CLI would) and, when told to behave, "calls" the
 * echo tool by reporting the run id parsed from the endpoint URL back to the
 * probe service — the same server-side observation the MCP host makes.
 */
interface ProbeConfig {
  mcpServers: {
    geniro: {
      url: string;
      headers: Record<string, string>;
      autoApprove: string[];
    };
  };
}

function fakeAdapter(behavior: {
  callsEcho: boolean;
  failsOnTrust?: boolean;
  /** Never settle until cancelled — exercises the probe's timeout guard. */
  hangs?: boolean;
}): {
  adapter: CursorAdapter;
  ref: { service?: CursorProbeService };
  starts: AgentTurnInput[];
  configs: ProbeConfig[];
} {
  const ref: { service?: CursorProbeService } = {};
  const starts: AgentTurnInput[] = [];
  const configs: ProbeConfig[] = [];
  const adapter = {
    start(input: AgentTurnInput, onEvent: (e: AgentEvent) => void) {
      starts.push(input);
      if (behavior.hangs) {
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        return {
          done,
          cancel: () => resolveDone(),
          respondApproval: () => false,
        };
      }
      const handle = {
        done: Promise.resolve(),
        cancel: vi.fn(),
        respondApproval: () => false,
      };
      // An old CLI rejects the flag before doing anything else.
      if (behavior.failsOnTrust && input.trustWorkspace) {
        onEvent({
          type: 'error',
          message:
            "cursor-agent exited with code 1: error: unknown option '--trust'",
        });
        return handle;
      }
      const config = JSON.parse(
        readFileSync(join(input.cwd, '.cursor', 'mcp.json'), 'utf8'),
      ) as ProbeConfig;
      configs.push(config);
      if (behavior.callsEcho) {
        const runId = config.mcpServers.geniro.url.split('/').at(-2)!;
        ref.service!.noteEchoCall(runId);
      }
      return handle;
    },
  } as unknown as CursorAdapter;
  return { adapter, ref, starts, configs };
}

function fakeExec(): { execFileFn: typeof execFile; calls: string[][] } {
  const calls: string[][] = [];
  const execFileFn = ((
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push(args);
    cb(null, '', '');
    return { kill: vi.fn(), once: vi.fn() };
  }) as unknown as typeof execFile;
  return { execFileFn, calls };
}

function build(
  behavior: { callsEcho: boolean; failsOnTrust?: boolean; hangs?: boolean },
  overrides: Partial<CursorProbeOptions> & {
    version?: string | null;
    runtime?: RuntimeInfo;
  } = {},
): {
  service: CursorProbeService;
  starts: AgentTurnInput[];
  configs: ProbeConfig[];
  enableCalls: string[][];
  root: string;
  cachePath: string;
} {
  const root = tempRoot();
  const cachePath = join(root, 'cache.json');
  const { adapter, ref, starts, configs } = fakeAdapter(behavior);
  const { execFileFn, calls } = fakeExec();
  const service = new CursorProbeService(
    adapter,
    new CallTokenRegistry(),
    new ProcessRegistry(),
    overrides.runtime ?? RUNTIME,
    {
      probeRootDir: join(root, 'probe'),
      cachePath,
      execFileFn,
      resolveVersionFn: async () =>
        overrides.version === undefined ? '2026.06.24' : overrides.version,
      ...overrides,
    },
  );
  ref.service = service;
  return { service, starts, configs, enableCalls: calls, root, cachePath };
}

describe('CursorProbeService', () => {
  it('passes when the spawned turn actually calls the echo tool, and persists the verdict', async () => {
    const { service, starts, configs, enableCalls, cachePath } = build({
      callsEcho: true,
    });
    const verdict = await service.ensureVerdict();

    expect(verdict.status).toBe('pass');
    expect(verdict.version).toBe('2026.06.24');
    // The temp workspace got the same targeted approval surfaces real turns
    // get: autoApprove bounded to the probe's ONE tool + a best-effort
    // `mcp enable geniro` — and never a blanket `--approve-mcps` anywhere.
    const input = starts[0]!;
    expect(input.trustWorkspace).toBe(true);
    expect(input.approvalMode).toBe('auto');
    expect(configs[0]!.mcpServers.geniro.autoApprove).toEqual(['echo']);
    expect(configs[0]!.mcpServers.geniro.headers.Authorization).toMatch(
      /^Bearer /,
    );
    expect(enableCalls).toContainEqual(['mcp', 'enable', 'geniro']);
    expect(enableCalls.every((args) => !args.includes('--approve-mcps'))).toBe(
      true,
    );
    // Verdict cached on disk, keyed by the binary version.
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toMatchObject({
      status: 'pass',
      version: '2026.06.24',
    });
    // The temp cwd is removed once the probe settles.
    expect(existsSync(input.cwd)).toBe(false);
    expect(service.capability().status).toBe('pass');
  });

  it('fails (with a reason) when the turn ends without ever calling echo', async () => {
    const { service } = build({ callsEcho: false });
    const verdict = await service.ensureVerdict();
    expect(verdict.status).toBe('fail');
    expect(verdict.reason).toContain('never called');
  });

  it('retries once WITHOUT --trust when the installed CLI rejects the flag — the verdict measures MCP trust, not argv support', async () => {
    const { service, starts } = build({ callsEcho: true, failsOnTrust: true });
    const verdict = await service.ensureVerdict();
    expect(verdict.status).toBe('pass');
    expect(starts).toHaveLength(2);
    expect(starts[0]!.trustWorkspace).toBe(true);
    expect(starts[1]!.trustWorkspace).toBeUndefined();
  });

  it('a hung probe turn is cancelled at the cap; the environmental fail is NEVER disk-cached', async () => {
    const { service, starts, cachePath } = build(
      { callsEcho: false, hangs: true },
      { turnTimeoutMs: 20 },
    );
    const verdict = await service.ensureVerdict();
    expect(verdict.status).toBe('fail');
    expect(verdict.reason).toContain('timed out');
    expect(starts).toHaveLength(1);
    // Environmental failure: memory-only for this launch, no cache poisoning.
    expect(existsSync(cachePath)).toBe(false);
    expect(service.capability().status).toBe('fail');
  });

  it('adopts a disk-cached verdict for the same binary version without spawning', async () => {
    const { service, starts, cachePath } = build({ callsEcho: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        status: 'fail',
        version: '2026.06.24',
        probedAt: 123,
        reason: 'cached',
      }),
    );
    const verdict = await service.ensureVerdict();
    expect(verdict).toMatchObject({ status: 'fail', reason: 'cached' });
    expect(starts).toHaveLength(0);
  });

  it('re-probes when the installed binary version changed', async () => {
    const { service, starts, cachePath } = build({ callsEcho: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        status: 'fail',
        version: 'OLD',
        probedAt: 123,
        reason: 'stale',
      }),
    );
    const verdict = await service.ensureVerdict();
    expect(verdict.status).toBe('pass');
    expect(starts).toHaveLength(1);
  });

  it('an unreadable version yields a memory-only verdict (never disk-poisoned)', async () => {
    const { service, starts, cachePath } = build(
      { callsEcho: true },
      { version: null },
    );
    const first = await service.ensureVerdict();
    expect(first.status).toBe('pass');
    expect(existsSync(cachePath)).toBe(false);
    // Memoized for this launch: no second spawn.
    const second = await service.ensureVerdict();
    expect(second.status).toBe('pass');
    expect(starts).toHaveLength(1);
  });

  it('reports unknown (and does not cache) while the daemon port is unbound', async () => {
    const { service, starts, cachePath } = build(
      { callsEcho: true },
      { runtime: { ...RUNTIME, port: null } },
    );
    const verdict = await service.ensureVerdict();
    expect(verdict.status).toBe('unknown');
    expect(starts).toHaveLength(0);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('is single-flight: concurrent callers share one probe turn', async () => {
    const { service, starts } = build({ callsEcho: true });
    const [a, b] = await Promise.all([
      service.ensureVerdict(),
      service.ensureVerdict(),
    ]);
    expect(a.status).toBe('pass');
    expect(b.status).toBe('pass');
    expect(starts).toHaveLength(1);
  });

  it('capabilitiesWire reports the current verdict and pre-warms the probe on unknown', async () => {
    const { service, starts } = build({ callsEcho: true });
    const wire = service.capabilitiesWire();
    expect(wire.cursorCalls.status).toBe('unknown');
    // The pre-warm fired in the background — joining it (single-flight) must
    // not start a second turn.
    await service.ensureVerdict();
    expect(starts).toHaveLength(1);
    expect(service.capabilitiesWire().cursorCalls.status).toBe('pass');
  });

  it('capabilitiesWire does NOT pre-warm while the daemon port is unbound', async () => {
    const { service, starts } = build(
      { callsEcho: true },
      { runtime: { ...RUNTIME, port: null } },
    );
    expect(service.capabilitiesWire().cursorCalls.status).toBe('unknown');
    await new Promise((r) => setTimeout(r, 10));
    expect(starts).toHaveLength(0);
  });
});
