import type { ChildProcess, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeModesCapability } from '../chat.types';
import type { SpawnedProcess, SpawnFn } from '../utils/spawn-cli';
import type { AdapterConfig, AgentApprovalMode } from './adapter.types';
import type { AgentAdapter } from './agent-adapter';
import { ClaudeAdapter } from './claude/claude.adapter';
import { CursorAcpAdapter } from './cursor-acp/cursor-acp.adapter';

/**
 * The config-driven members the base answers for EVERY adapter, driven through
 * the two shipped ones — the only way to prove a value-driven base did not
 * quietly change what an adapter used to decide for itself.
 */
const ADAPTERS: { name: string; adapter: AgentAdapter }[] = [
  { name: 'claude', adapter: new ClaudeAdapter() },
  { name: 'cursor-agent', adapter: new CursorAcpAdapter() },
];

/**
 * A CLI that honours ONE mode and ALSO carries a probe-table entry for the
 * mode being asked for — the collision the two shipped adapters never have, and
 * the only shape that can tell the two orderings apart.
 */
class SoleModeWithProbeTableAdapter extends CursorAcpAdapter {
  override getConfig(): AdapterConfig {
    const base = super.getConfig();
    return {
      ...base,
      approval: {
        ...base.approval,
        // Declared, not inherited: every shipped adapter now honours several
        // modes, so the sole-mode collapse this pins has to be stated here or
        // the fixture stops exercising it.
        modes: ['auto'],
        soleModeDegradeReason: (requested) =>
          `test CLI has no approval callback — approval '${requested}' degrades to auto-approve for this turn`,
        degradeOnProbeFail: {
          acceptEdits: { to: 'ask', reason: 'probe table won' },
        },
      },
    };
  }
}

/**
 * The shipped claude report config, or a loud failure — the fixture below is
 * only meaningful over a CLI that DOES report its commands, so a claude that
 * stopped must break this spec rather than silently degrade it.
 */
function reportedCommandsOf(
  config: AdapterConfig,
): NonNullable<AdapterConfig['reportedCommands']> {
  if (!config.reportedCommands) {
    throw new Error(`${config.kind} declares no reportedCommands`);
  }
  return config.reportedCommands;
}

/**
 * A CLI that DOES report its own commands but declares no internal-name prefix
 * — the arm neither shipped adapter exercises (claude declares `_`, cursor
 * makes no report at all).
 */
class NoInternalPrefixAdapter extends ClaudeAdapter {
  override getConfig(): AdapterConfig {
    const base = super.getConfig();
    return {
      ...base,
      reportedCommands: {
        // Track the SHIPPED config and override the one field under test —
        // hand-retyping the other values here is how a fixture starts
        // asserting against a claude that no longer exists.
        ...reportedCommandsOf(base),
        internalPrefix: null,
      },
    };
  }
}

/**
 * The slice of a child the turn plumbing touches, on real streams so a scripted
 * stdout line reaches the mapper — and DYING on the signal, because the probe
 * cancels its own turn and then awaits `done`.
 */
class ProbeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    setTimeout(() => this.emit('close', null, signal), 0);
    return true;
  }
}

const spawning = (child: ProbeChild): SpawnFn => {
  return () => child as unknown as SpawnedProcess;
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-probe-root-'));
  dirs.push(dir);
  return dir;
}

describe('AgentAdapter.resolveApprovalMode', () => {
  it('collapses a sole-mode CLI BEFORE consulting the probe table', () => {
    // Order is the behaviour: a single-mode CLI has nothing to probe, so a
    // probe-table entry must not route its turn to `ask` — a mode it does not
    // honour at all. Reversing the two steps yields { mode: 'ask' } here.
    const resolved = new SoleModeWithProbeTableAdapter().resolveApprovalMode(
      'acceptEdits',
      { supported: { acceptEdits: false } },
    );

    expect(resolved.mode).toBe('auto');
    expect(resolved.degradeReason).toContain(
      "approval 'acceptEdits' degrades to auto-approve",
    );
  });

  it('keeps the sole mode itself untouched, with nothing to report', () => {
    expect(
      new CursorAcpAdapter().resolveApprovalMode('auto', {
        supported: { acceptEdits: false },
      }),
    ).toEqual({ mode: 'auto', degradeReason: null });
  });

  it("never degrades claude's plan — an executing fallback inverts what it promises", () => {
    // `plan` is probed exactly like acceptEdits and its FAIL is proved here,
    // yet it is deliberately ABSENT from claude's degradeOnProbeFail table:
    // turning a no-execute mode into an executing one would invert the intent
    // the user selected it for. Adding it "for completeness" fails this.
    expect(
      new ClaudeAdapter().resolveApprovalMode('plan', {
        supported: { plan: false },
      }),
    ).toEqual({ mode: 'plan', degradeReason: null });
  });

  it('degrades acceptEdits ONLY on a PROVED false, never on an absent verdict', () => {
    const adapter = new ClaudeAdapter();

    const proved = adapter.resolveApprovalMode('acceptEdits', {
      supported: { acceptEdits: false },
    });
    expect(proved.mode).toBe('ask');
    expect(proved.degradeReason).toContain('does not support acceptEdits');

    // Absent ≠ false: nobody asked this binary, so degrading here would
    // pre-empt the CLI's own answer on a guess.
    expect(
      adapter.resolveApprovalMode('acceptEdits', { supported: {} }),
    ).toEqual({ mode: 'acceptEdits', degradeReason: null });
    // And a PASS is not a reason to degrade either.
    expect(
      adapter.resolveApprovalMode('acceptEdits', {
        supported: { acceptEdits: true },
      }),
    ).toEqual({ mode: 'acceptEdits', degradeReason: null });
  });
});

describe('AgentAdapter.approvalSupportFrom', () => {
  /** Every probed mode PROVED unsupported on the installed binary. */
  const failingBag: ClaudeModesCapability = {
    acceptEdits: 'fail',
    plan: 'fail',
    version: '2.1.220 (Claude Code)',
    probedAt: 1_700_000_000_000,
    reason: 'probe failed both',
  };

  for (const { name, adapter } of ADAPTERS) {
    it(`answers false for every mode ${name} declares as probed, given a failing bag`, () => {
      // The guard on the base's `{ supported: {} }` default: an adapter that
      // DECLARES probed modes must actually read its verdict out of the bag.
      // Delete claude's approvalSupportFrom override and its two probed modes
      // come back absent instead of false — every degrade silently stops.
      const support = adapter.approvalSupportFrom({ claudeModes: failingBag });

      for (const mode of adapter.getConfig().approval.probedModes) {
        expect(support.supported[mode]).toBe(false);
      }
      // Nothing is invented for a mode the adapter never declared probed.
      const probed: readonly AgentApprovalMode[] =
        adapter.getConfig().approval.probedModes;
      expect(
        Object.keys(support.supported).every((mode) =>
          probed.includes(mode as AgentApprovalMode),
        ),
      ).toBe(true);
    });
  }
});

describe('AgentAdapter.listEfforts', () => {
  for (const { name, adapter } of ADAPTERS) {
    it(`hands back ${name}'s declared effort vocabulary, as a copy`, () => {
      expect(adapter.listEfforts()).toEqual([...adapter.getConfig().efforts]);
      // A caller must not be able to mutate the shared config through it.
      expect(adapter.listEfforts()).not.toBe(adapter.getConfig().efforts);
    });
  }
});

describe('AgentAdapter question channel', () => {
  /** Claude's AskUserQuestion shape — the only question payload that ships. */
  const QUESTION_INPUT = {
    questions: [
      {
        question: 'Which color?',
        options: [{ label: 'Red' }, { label: 'Blue' }],
      },
    ],
  };

  for (const { name, adapter } of ADAPTERS) {
    it(`projects a question exactly when ${name} declares a question tool`, () => {
      // The two halves of the seam must agree with the ONE declared fact: a
      // CLI with `questionToolName: null` has no channel, so the base default
      // answers null and echoes the input BY REFERENCE (nothing to fold into);
      // a CLI that declares one must override both, or a callee's question
      // reaches its caller blank and the answer never reaches the CLI.
      const hasChannel = adapter.getConfig().questionToolName !== null;

      expect(adapter.questionFrom(QUESTION_INPUT) !== null).toBe(hasChannel);
      expect(adapter.withAnswer(QUESTION_INPUT, 'Red') === QUESTION_INPUT).toBe(
        !hasChannel,
      );
    });
  }
});

describe('AgentAdapter.listReportedCommands', () => {
  it('answers [] without spawning when the CLI makes no such report', async () => {
    // cursor-agent's `reportedCommands: null` is the declared fact — it has no
    // built-in slash commands and no equivalent of claude's `system/init` list.
    // The base must honour it by never starting a turn: a probe spawn per
    // autocomplete read, for a CLI that can only answer nothing, is pure cost.
    let spawned = 0;
    const spawn: SpawnFn = () => {
      spawned += 1;
      throw new Error('the probe must not spawn for a CLI with no report');
    };
    // A usable probe root on purpose: the ONLY thing that may keep this from
    // spawning is the config gate, never a workspace that could not be made.
    const adapter = new CursorAcpAdapter({ spawn, probeRootDir: tempDir() });

    await expect(adapter.listReportedCommands()).resolves.toEqual([]);
    expect(spawned).toBe(0);
  });

  it('keeps every reported name when the CLI declares no internal prefix', async () => {
    // `internalPrefix` is per-CLI DATA, and null means "this CLI has no
    // internal names" — dropping a `_`-prefixed command for such a CLI would
    // hide a command the user can genuinely invoke.
    const child = new ProbeChild();
    const adapter = new NoInternalPrefixAdapter({
      spawn: spawning(child),
      probeRootDir: tempDir(),
    });

    const reported = adapter.listReportedCommands();
    child.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'probe-1',
        slash_commands: ['clear', '_hidden'],
      })}\n`,
    );

    await expect(reported).resolves.toEqual(['clear', '_hidden']);
  });
});

describe('AgentAdapter.supportsLiveStream', () => {
  it('answers false without spawning when the CLI has no such mode', async () => {
    // cursor-agent's `liveStream: null` is the declared fact; the base must
    // honour it by never reaching for the binary at all.
    let spawned = 0;
    const execFileFn = ((
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, out: string) => void,
    ) => {
      spawned += 1;
      cb(null, '  --include-partial-messages\n');
      return {} as ChildProcess;
    }) as unknown as typeof execFile;
    const adapter = new CursorAcpAdapter({ execFileFn });

    await expect(adapter.supportsLiveStream()).resolves.toBe(false);
    expect(spawned).toBe(0);
  });
});

/**
 * A CLI that claims it CAN be listed but supplies no mechanism — the shape a
 * future adapter author lands in by filling in config and forgetting the
 * override. Neither shipped adapter can reach the base fallback.
 */
class ForgotToOverrideAdapter extends CursorAcpAdapter {
  override getConfig(): AdapterConfig {
    const base = super.getConfig();
    return {
      ...base,
      mcp: { ...base.mcp, listingUnavailableReason: null },
    };
  }
}

describe('AgentAdapter.listMcpServers', () => {
  it('refuses rather than claiming an empty folder when an adapter forgot to override', async () => {
    // The safety net: answering `{ ok: true, servers: [] }` here would let the
    // service cache it and the panel state, as fact, that the user has no MCP
    // servers — on a CLI nobody ever asked.
    await expect(
      new ForgotToOverrideAdapter().listMcpServers({ cwd: '/tmp' }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('does not implement MCP listing'),
    });
  });

  it('reports a failure when the CLI answered but nothing parsed as a row', async () => {
    // Version drift: a release that rewords the row format drops every row.
    // Reporting that as an empty listing is the confident lie the ok/err split
    // exists to prevent — and it would be cached for the whole TTL.
    const execFileFn = ((
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, out: string) => void,
    ) => {
      cb(null, 'Checking MCP server health…\n\nsentry => node s.js [ok]\n');
      return { pid: 4246, kill: () => true } as unknown as ChildProcess;
    }) as unknown as typeof execFile;

    await expect(
      new ClaudeAdapter({ execFileFn }).listMcpServers({ cwd: '/tmp' }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('output format may have changed'),
    });
  });

  it('reports a genuinely empty folder as an empty SUCCESS, not a failure', async () => {
    // The other side of that check — the CLI's own empty-folder sentence is
    // the one thing that makes `[]` a fact about the user's configuration.
    const execFileFn = ((
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, out: string) => void,
    ) => {
      cb(
        null,
        'No MCP servers configured. Use `claude mcp add` to add a server.\n',
      );
      return { pid: 4247, kill: () => true } as unknown as ChildProcess;
    }) as unknown as typeof execFile;

    await expect(
      new ClaudeAdapter({ execFileFn }).listMcpServers({ cwd: '/tmp' }),
    ).resolves.toEqual({ ok: true, servers: [] });
  });
  it('cursor-agent refuses with its own reason, and writes no code to do it', async () => {
    // The declared absence: cursor carries only the config string, so there is
    // no override that could drift from it. The panel can ask EVERY agent
    // without knowing which one it holds.
    const adapter = new CursorAcpAdapter();

    await expect(adapter.listMcpServers({ cwd: '/tmp' })).resolves.toEqual({
      ok: false,
      reason: adapter.getConfig().mcp.listingUnavailableReason,
    });
  });

  it('claude turns the CLI’s own output into rows', async () => {
    const execFileFn = ((
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, out: string) => void,
    ) => {
      cb(
        null,
        'Checking MCP server health…\n\nsentry: node s.js - √ Connected\n',
      );
      return { pid: 321, kill: () => true } as unknown as ChildProcess;
    }) as unknown as typeof execFile;

    await expect(
      new ClaudeAdapter({ execFileFn }).listMcpServers({ cwd: '/tmp' }),
    ).resolves.toEqual({
      ok: true,
      servers: [
        {
          name: 'sentry',
          target: 'node s.js',
          transport: 'stdio',
          status: 'connected',
          detail: null,
        },
      ],
    });
  });

  it('claude reports a FAILURE, not an empty folder, when it cannot be run', async () => {
    // Missing binary / not signed in / timeout all arrive as a null stdout.
    // Reporting that as `ok: true, servers: []` would let the service cache it
    // and the panel state, untruthfully, that the folder has no MCP servers.
    const execFileFn = (() => {
      throw new Error('spawn claude ENOENT');
    }) as unknown as typeof execFile;

    const result = await new ClaudeAdapter({ execFileFn }).listMcpServers({
      cwd: '/tmp',
    });

    expect(result.ok).toBe(false);
  });

  it('asks the CLI for the listing in the folder it was given', async () => {
    // The whole reason cwd exists on the utility contract: the answer is
    // folder-scoped, so the wrong folder yields a confidently wrong list.
    const calls: { args: readonly string[]; cwd: unknown }[] = [];
    const execFileFn = ((
      _cmd: string,
      args: readonly string[],
      opts: Record<string, unknown>,
      cb: (err: Error | null, out: string) => void,
    ) => {
      calls.push({ args, cwd: opts.cwd });
      cb(null, '');
      return { pid: 322, kill: () => true } as unknown as ChildProcess;
    }) as unknown as typeof execFile;

    await new ClaudeAdapter({ execFileFn }).listMcpServers({
      cwd: '/home/me/project-a',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['mcp', 'list']);
    expect(calls[0]?.cwd).toBe('/home/me/project-a');
  });
});

describe('AgentAdapter.runCommand spawn options', () => {
  /** Capture the options object `runCommand` hands to execFile. */
  function capturingAdapter(): {
    adapter: ClaudeAdapter;
    seen: () => Record<string, unknown>;
  } {
    let opts: Record<string, unknown> = {};
    const execFileFn = ((
      _cmd: string,
      _args: readonly string[],
      options: Record<string, unknown>,
      cb: (err: Error | null, out: string) => void,
    ) => {
      opts = options;
      cb(null, '');
      return { pid: 999, kill: () => true } as unknown as ChildProcess;
    }) as unknown as typeof execFile;
    return {
      adapter: new ClaudeAdapter({ execFileFn }),
      seen: () => opts,
    };
  }

  it('a process-group command spawns detached and drops execFile’s own timeout', async () => {
    // Both halves matter: `detached` is what creates the group, and leaving
    // execFile's timeout in place would fire a single-PID kill first — exactly
    // the orphaning the group spawn exists to prevent.
    const { adapter, seen } = capturingAdapter();

    await adapter.listMcpServers({ cwd: '/tmp/some-project' });

    expect(seen().detached).toBe(true);
    expect(seen().timeout).toBeUndefined();
  });

  it('kills the whole group when the deadline passes, and settles the read', async () => {
    // Dropping execFile's timeout is only safe because this replacement timer
    // exists. It must do BOTH things: reap the group (a grandchild that
    // survives holds the inherited stdout pipe open, so execFile's callback
    // never fires) and settle the promise, or the service's in-flight slot for
    // that folder is wedged for the life of the daemon.
    vi.useFakeTimers();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      const execFileFn = (() =>
        // Never calls back — the wedged-grandchild case.
        ({
          pid: 4242,
          kill: () => true,
        }) as unknown as ChildProcess) as unknown as typeof execFile;

      const pending = new ClaudeAdapter({ execFileFn }).listMcpServers(
        { cwd: '/tmp' },
        { timeoutMs: 50 },
      );
      await vi.advanceTimersByTimeAsync(50);

      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
      await expect(pending).resolves.toEqual({
        ok: false,
        reason: expect.stringContaining('could not read'),
      });
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not fire the group kill once the command has answered', async () => {
    // The timer is armed BEFORE the spawn (a synchronous execFileFn would
    // otherwise leave one nothing can clear), so the settle path must clear it
    // — else it later SIGKILLs whatever process group now owns that pid.
    vi.useFakeTimers();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      const execFileFn = ((
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, out: string) => void,
      ) => {
        cb(null, '');
        return { pid: 4243, kill: () => true } as unknown as ChildProcess;
      }) as unknown as typeof execFile;

      await new ClaudeAdapter({ execFileFn }).listMcpServers({ cwd: '/tmp' });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reaps the group when execFile kills the direct child itself', async () => {
    // execFile's own failure paths (maxBuffer overflow, its own signal) kill
    // the direct pid only. Without this the grandchildren — the user's MCP
    // servers — survive with the timer already cleared and nothing left to
    // reap them, which is the exact orphaning this spawn mode exists to stop.
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      const execFileFn = ((
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, out: string) => void,
      ) => {
        cb(new Error('stdout maxBuffer length exceeded'), '');
        return { pid: 4244, kill: () => true } as unknown as ChildProcess;
      }) as unknown as typeof execFile;

      await new ClaudeAdapter({ execFileFn }).listMcpServers({ cwd: '/tmp' });

      expect(killSpy).toHaveBeenCalledWith(-4244, 'SIGKILL');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('reaps the group ONCE, even when the command exits after the deadline', async () => {
    // The deadline reaps and settles; the exec callback then arrives with an
    // error and runs its own error-path reap. By then node has waitpid'd the
    // child, so a second `kill(-pid)` can land on whatever now owns that pid.
    vi.useFakeTimers();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      let fire!: () => void;
      const execFileFn = ((
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, out: string) => void,
      ) => {
        fire = () => cb(new Error('killed'), '');
        return { pid: 4248, kill: () => true } as unknown as ChildProcess;
      }) as unknown as typeof execFile;

      // An EXPLICIT deadline, not the shipped constant: a bare literal that
      // has to match `CLAUDE_MCP_LIST_TIMEOUT_MS` goes vacuous the moment that
      // constant is retuned — the timer never fires and this stops testing the
      // ordering it names, silently.
      const pending = new ClaudeAdapter({ execFileFn }).listMcpServers(
        { cwd: '/tmp' },
        { timeoutMs: 50 },
      );
      await vi.advanceTimersByTimeAsync(50); // deadline reaps + settles
      fire(); // the child's own exit lands afterwards
      await pending;

      expect(killSpy).toHaveBeenCalledTimes(1);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('hands the registration site what it actually spawned', async () => {
    // The pairing invariant: `childProcessHandle(child, spawnInfo)` is correct
    // by construction only because spawnInfo comes from the spawn. A caller
    // writing `{ processGroup: true }` by hand could disagree with it.
    const seen: { processGroup: boolean }[] = [];
    const execFileFn = ((
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, out: string) => void,
    ) => {
      cb(null, '');
      return { pid: 4245, kill: () => true } as unknown as ChildProcess;
    }) as unknown as typeof execFile;
    const adapter = new ClaudeAdapter({ execFileFn });

    await adapter.listMcpServers(
      { cwd: '/tmp' },
      { onSpawn: (_child, spawnInfo) => seen.push(spawnInfo) },
    );
    await adapter.supportsLiveStream({
      onSpawn: (_child, spawnInfo) => seen.push(spawnInfo),
    });

    expect(seen).toEqual([{ processGroup: true }, { processGroup: false }]);
  });

  it('leaves an ordinary utility command undetached, on execFile’s timeout', async () => {
    // The default path is unchanged — every pre-existing caller (--version,
    // --help probes) must keep spawning exactly as it did.
    const { adapter, seen } = capturingAdapter();

    await adapter.supportsLiveStream();

    expect(seen().detached).toBeUndefined();
    expect(seen().timeout).toBe(10_000);
    expect(seen().cwd).toBeUndefined();
  });
});
