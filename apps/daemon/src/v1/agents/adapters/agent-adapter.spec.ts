import type { ChildProcess, execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeSpawn } from '../__tests__/fake-child';
import type { ClaudeModesCapability } from '../chat.types';
import { GROUP_KILL_GRACE_MS } from '../utils/kill-tree';
import type { SpawnedProcess, SpawnFn } from '../utils/spawn-cli';
import { fakeGroupChild, spawnAnswering } from './__tests__/fake-group-child';
import type {
  AdapterConfig,
  AgentApprovalMode,
  AgentCommandOptions,
  AgentEvent,
  AgentModel,
  AgentTurnInput,
  FollowUpMessage,
} from './adapter.types';
import { AgentAdapter } from './agent-adapter';
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

describe('AgentAdapter.followUp declares what buildFollowUpPayload does', () => {
  /**
   * `buildFollowUpPayload` is protected and per-turn, so the renderer can only
   * learn about it through `config.followUp`. That makes the two a promise and
   * its implementation, in different files, with nothing in the type system
   * tying them together — so this is the tie.
   *
   * A config claiming a channel the adapter never implements is the failure
   * that matters: the composer would offer "send now", the daemon would answer
   * RUN_BUSY, and the message would silently sit in the queue the button said
   * it was skipping.
   */
  const payloadFor = (adapter: AgentAdapter): string | undefined =>
    (
      adapter as unknown as {
        buildFollowUpPayload(message: FollowUpMessage): string | undefined;
      }
    ).buildFollowUpPayload({ text: 'a follow-up', images: undefined });

  for (const { name, adapter } of ADAPTERS) {
    it(`${name} says the same thing in its config and in its code`, () => {
      const configSaysItCan =
        adapter.getConfig().followUp.unavailableReason === null;

      expect(payloadFor(adapter) !== undefined).toBe(configSaysItCan);
    });
  }

  it('is not vacuous — the shipped pair covers BOTH answers', () => {
    // Without this the loop above passes if every adapter answers "cannot",
    // which is exactly what a careless `followUp` copy-paste onto a new
    // adapter would produce.
    const answers = ADAPTERS.map(
      ({ adapter }) => adapter.getConfig().followUp.unavailableReason === null,
    );

    expect(new Set(answers)).toEqual(new Set([true, false]));
  });

  it('gives a REASON, never a bare cannot', () => {
    for (const { adapter } of ADAPTERS) {
      const reason = adapter.getConfig().followUp.unavailableReason;
      // The renderer prints this on the disabled control. An empty string
      // would render as a control that refuses without saying why — the
      // silent refusal every capability field here exists to replace.
      if (reason !== null) {
        expect(reason.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe('AgentAdapter.mcpLoginTarget', () => {
  /** A CLI with no sign-in command — the shape neither shipped adapter has. */
  class NoLoginAdapter extends ClaudeAdapter {
    override getConfig(): AdapterConfig {
      const base = super.getConfig();
      return { ...base, mcp: { ...base.mcp, loginArgs: null } };
    }
  }

  for (const { name, adapter } of ADAPTERS) {
    it(`builds ${name}'s own sign-in invocation, ending in the server name`, () => {
      const target = adapter.mcpLoginTarget('probe-linear');

      // Composed from the adapter's OWN declared argv, never a spelled
      // `['mcp','login']` here: a spec that retypes the words passes even when
      // the adapter stops carrying them.
      expect(target).toEqual({
        ok: true,
        kind: 'command',
        command: expect.any(String),
        args: [...(adapter.getConfig().mcp.loginArgs ?? []), 'probe-linear'],
      });
    });
  }

  it('refuses for a CLI that declares no sign-in command', () => {
    // The defensive arm, entered deliberately. Both shipped CLIs have `mcp
    // login`, so nothing else reaches it — and a `loginArgs: null` that spread
    // an empty argv instead would compose `claude probe-linear`, opening a
    // terminal that runs the server name as a prompt.
    expect(new NoLoginAdapter().mcpLoginTarget('probe-linear')).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });
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
 * The bare minimum an adapter author must supply, and NOTHING else.
 *
 * Built on `AgentAdapter` itself rather than on a shipped adapter because both
 * shipped ones now override `listMcpServers` — subclassing either would inherit
 * that override and never reach the base fallback these cases exist to pin.
 * (Milestone 4: cursor gained a real listing, and this fixture used to extend
 * it.)
 */
class BareAdapter extends AgentAdapter {
  constructor(private readonly listingReason: string | null) {
    super({});
  }

  protected get command(): string {
    // Never spawned: neither base path this fixture exercises reaches a child.
    return 'no-such-binary';
  }

  getConfig(): AdapterConfig {
    const base = new CursorAcpAdapter().getConfig();
    return {
      ...base,
      mcp: { ...base.mcp, listingUnavailableReason: this.listingReason },
    };
  }

  protected buildArgs(): string[] {
    return [];
  }

  protected mapMessage(): AgentEvent[] {
    throw new Error('not exercised');
  }

  override listModels(): Promise<AgentModel[]> {
    return Promise.resolve([]);
  }
}

/**
 * A CLI that CAN keep a process between turns but has no message for changing
 * its approval mode — the combination claude cannot produce (both of its
 * answers come from `keepStdinOpen`) and the one the base's re-mode refusal
 * exists for.
 */
class SessionWithoutModeChangeAdapter extends AgentAdapter {
  constructor(spawn: SpawnFn) {
    super({ spawn });
  }

  protected get command(): string {
    return 'sessionful-cli';
  }

  getConfig(): AdapterConfig {
    return new CursorAcpAdapter().getConfig();
  }

  protected buildArgs(): string[] {
    return [];
  }

  /** `{"done":true}` is this fake CLI's whole result-line vocabulary. */
  protected mapMessage(obj: unknown): AgentEvent[] {
    return (obj as { done?: boolean }).done === true
      ? [
          {
            type: 'turn_complete',
            usage: null,
            stopReason: null,
            finalText: null,
          },
        ]
      : [];
  }

  override listModels(): Promise<AgentModel[]> {
    return Promise.resolve([]);
  }

  protected override canHostSession(): boolean {
    return true;
  }

  protected override buildNextTurnPayload(): string {
    return 'next\n';
  }

  // Left at the base default (undefined) on purpose: this CLI has no such
  // message, which is exactly what the refusal below is about.
}

describe('AgentAdapter re-modes a session it can, and refuses one it cannot', () => {
  it('refuses a turn whose mode the running process cannot be told about', async () => {
    // Silently accepting would run the turn under the mode the PREVIOUS one
    // was spawned with, while the chip and the persisted run row read the new
    // one. Null is what the registry already handles: it closes the session
    // and respawns, putting the mode back in argv where it started.
    const { spawn, child } = fakeSpawn();
    const input: AgentTurnInput = {
      prompt: 'first',
      cwd: '/proj',
      approvalMode: 'acceptEdits',
    };
    const session = new SessionWithoutModeChangeAdapter(spawn).startSession(
      input,
      { runScoped: true },
    );

    const first = session.startTurn(input, () => {});
    expect(first).not.toBeNull();
    child.stdout.emitData('{"done":true}\n');
    await first?.done;

    expect(
      session.startTurn({ ...input, approvalMode: 'ask' }, () => {}),
    ).toBeNull();
    // …while the SAME mode is still served on that process, so the refusal is
    // about the mode change and not about the session being spent.
    expect(session.startTurn(input, () => {})).not.toBeNull();
  });
});

describe('AgentAdapter.listMcpServers', () => {
  it('refuses rather than claiming an empty folder when an adapter forgot to override', async () => {
    // The safety net: answering `{ ok: true, servers: [] }` here would let the
    // service cache it and the panel state, as fact, that the user has no MCP
    // servers — on a CLI nobody ever asked.
    await expect(
      new BareAdapter(null).listMcpServers({ cwd: '/tmp' }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('does not implement MCP listing'),
    });
  });

  it('reports a failure when the CLI answered but nothing parsed as a row', async () => {
    // Version drift: a release that rewords the row format drops every row.
    // Reporting that as an empty listing is the confident lie the ok/err split
    // exists to prevent — and it would be cached for the whole TTL.
    const groupSpawnFn = spawnAnswering(
      'Checking MCP server health…\n\nsentry => node s.js [ok]\n',
      4246,
    );

    await expect(
      new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('output format may have changed'),
    });
  });

  it('reports a genuinely empty folder as an empty SUCCESS, not a failure', async () => {
    // The other side of that check — the CLI's own empty-folder sentence is
    // the one thing that makes `[]` a fact about the user's configuration.
    const groupSpawnFn = spawnAnswering(
      'No MCP servers configured. Use `claude mcp add` to add a server.\n',
      4247,
    );

    await expect(
      new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' }),
    ).resolves.toEqual({ ok: true, servers: [] });
  });
  it('an adapter that declares an absence refuses with its own reason, writing no code to do it', async () => {
    // A CLI with no listing states that in config alone and the base does the
    // rest, so there is no override that could drift from the sentence the
    // panel shows. Both SHIPPED adapters can now be asked for real (milestone
    // 4 verified cursor's `mcp list`), which is exactly why this is pinned on a
    // fixture: the guarantee is about the base class, not about who currently
    // needs it.
    const adapter = new BareAdapter('this CLI has no listing');

    await expect(adapter.listMcpServers({ cwd: '/tmp' })).resolves.toEqual({
      ok: false,
      reason: 'this CLI has no listing',
    });
  });

  it('claude turns the CLI’s own output into rows', async () => {
    const groupSpawnFn = spawnAnswering(
      'Checking MCP server health…\n\nsentry: node s.js - √ Connected\n',
      321,
    );

    await expect(
      new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' }),
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
    const groupSpawnFn = (() => {
      throw new Error('spawn claude ENOENT');
    }) as unknown as typeof spawn;

    const result = await new ClaudeAdapter({ groupSpawnFn }).listMcpServers({
      cwd: '/tmp',
    });

    expect(result.ok).toBe(false);
  });

  it('asks the CLI for the listing in the folder it was given', async () => {
    // The whole reason cwd exists on the utility contract: the answer is
    // folder-scoped, so the wrong folder yields a confidently wrong list.
    const calls: { args: readonly string[]; cwd: unknown }[] = [];
    const groupSpawnFn = spawnAnswering('', 322, (args, opts) =>
      calls.push({ args, cwd: opts.cwd }),
    );

    await new ClaudeAdapter({ groupSpawnFn }).listMcpServers({
      cwd: '/home/me/project-a',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['mcp', 'list']);
    expect(calls[0]?.cwd).toBe('/home/me/project-a');
  });
});

/**
 * Runs a REAL child (this node binary) through `runCommand`, so the one thing
 * no double can show — whether the OS actually put the child in its own
 * process group — is observable.
 */
class RealSpawnAdapter extends BareAdapter {
  constructor() {
    super(null);
  }

  protected override get command(): string {
    return process.execPath;
  }

  run(args: string[], options: AgentCommandOptions): Promise<string | null> {
    return this.runCommand(args, options);
  }
}

describe('AgentAdapter.runCommand process groups (real children)', () => {
  it('puts a group command in its OWN group, and an ordinary one in ours', async () => {
    // THE assertion that would have caught the defect this rewrite fixes.
    // Every other spec in this file pins that we ASK for a group; only the
    // child's real pgid proves one exists. `execFile` accepted `detached` in
    // its options bag and silently dropped it before reaching `spawn`, so the
    // call-level assertions stayed green while no group was ever created and
    // every `kill(-pid)` addressed nobody.
    //
    // Probed inside `onSpawn`, the only moment the child is guaranteed alive.
    // `kill(-pid, 0)` sends no signal — it asks the kernel whether a process
    // GROUP with that id exists, which is exactly the question `kill(-pid,
    // 'SIGKILL')` silently got wrong before.
    const groupExists = (pid: number | undefined): boolean => {
      if (pid === undefined) {
        // `kill(-0)` signals the CALLER's group and would answer "yes" for a
        // child that never spawned — a silent pass on the one assertion here
        // that is load-bearing.
        throw new Error('child had no pid');
      }
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const adapter = new RealSpawnAdapter();
    const script = 'process.stdout.write("grouped")';

    let groupPid: number | undefined;
    let leadsOwnGroup = false;
    const grouped = await adapter.run(['-e', script], {
      processGroup: true,
      onSpawn: (child) => {
        groupPid = child.pid;
        leadsOwnGroup = groupExists(child.pid);
      },
    });

    expect(grouped).toBe('grouped');
    expect(groupPid).toBeGreaterThan(0);
    expect(leadsOwnGroup).toBe(true);

    let plainLeadsOwnGroup = true;
    await adapter.run(['-e', script], {
      onSpawn: (child) => {
        plainLeadsOwnGroup = groupExists(child.pid);
      },
    });

    // The other half: an ordinary utility command must NOT be detached, or
    // the daemon stops being able to signal it as part of its own group.
    //
    // Reads "no group with that id exists". Strictly this could answer wrongly
    // if the child's pid happened to equal a live pgid after wraparound — a
    // collision, not a behaviour — so the sibling assertion above (which pins
    // that `detached` is absent from the plain path's options) is what carries
    // the guarantee if this one ever flakes.
    expect(plainLeadsOwnGroup).toBe(false);
  });

  it('reads a command that writes more to stderr than the pipe can hold', async () => {
    // `stdio: ['pipe', 'pipe', 'pipe']` opens a stderr pipe nothing consumes.
    // A child that writes past the OS pipe buffer (64 KiB on Linux) then never
    // drains it never exits, so `close` never fires and the read reports the
    // folder unreadable after the full deadline — for a command that printed
    // its whole answer. `execFile` drained stderr itself (it buffers it for
    // the error object), so this is reachable only on the group path.
    //
    // `mcp list` is the group-path command, and it HEALTH-CHECKS: it launches
    // the user's own MCP servers, whose startup noise lands on the CLI's
    // stderr, which is this pipe.
    const adapter = new RealSpawnAdapter();
    const script =
      'process.stderr.write("e".repeat(512 * 1024)); process.stdout.write("done");';

    const out = await adapter.run(['-e', script], {
      processGroup: true,
      timeoutMs: 3_000,
    });

    expect(out).toBe('done');
  }, 15_000);
});

/**
 * A shipped adapter with `runCommand` exposed, so a spec can read the RAW
 * stdout the collector produced instead of whatever survived a parser.
 */
class RawCommandAdapter extends ClaudeAdapter {
  run(args: string[], options: AgentCommandOptions): Promise<string | null> {
    return this.runCommand(args, options);
  }
}

describe('AgentAdapter.runCommand spawn options', () => {
  it('a process-group command goes through spawn, detached, with piped stdio', async () => {
    // The whole finding this replaced: `detached` was being handed to
    // `execFile`, which forwards only cwd/env/uid/gid/shell/windows* down to
    // `spawn` and silently drops the rest. The child therefore never led a
    // group and every `kill(-pid)` addressed nobody. This pins the CALL; the
    // real-children describe above pins the OUTCOME.
    let opts: Record<string, unknown> = {};
    const groupSpawnFn = spawnAnswering('', 999, (_args, options) => {
      opts = options;
    });

    await new ClaudeAdapter({ groupSpawnFn }).listMcpServers({
      cwd: '/tmp/some-project',
    });

    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(opts.cwd).toBe('/tmp/some-project');
    // execFile's own deadline would be a single-PID kill; the group path owns
    // its deadline instead, so no `timeout` may ride along.
    expect(opts.timeout).toBeUndefined();
  });

  it('collects the child’s stdout off the pipe rather than a callback', async () => {
    // `spawn` hands back no buffered stdout, so the collector is ours. If it
    // regressed to returning '' the parser above would report every folder as
    // unreadable, so this is the assertion holding the rewrite together.
    const groupSpawnFn = spawnAnswering(
      'Checking MCP server health…\n\nsentry: node s.js - √ Connected\n',
      777,
    );

    await expect(
      new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' }),
    ).resolves.toMatchObject({ ok: true, servers: [{ name: 'sentry' }] });
  });

  it('joins a multi-byte character that arrived split across two stdout chunks', async () => {
    // A pipe read boundary falls wherever the kernel put it, so a UTF-8
    // sequence routinely straddles two `data` events. Decoding each chunk on
    // its own turns the halves into replacement characters — the CLI's own
    // output already carries non-ASCII (`√ Connected`, `health…`), and a
    // mangled row is a server name the user never configured.
    // `execFile`'s `encoding: 'utf8'` decoded the STREAM, not the chunk.
    const payload = Buffer.from('café', 'utf8');
    const chunks = [
      payload.subarray(0, payload.length - 1),
      payload.subarray(payload.length - 1),
    ];
    const groupSpawnFn = ((): unknown => {
      const fake = fakeGroupChild(4251);
      queueMicrotask(() => {
        for (const chunk of chunks) {
          fake.writeStdout(chunk);
        }
        fake.close(0);
      });
      return fake.child;
    }) as unknown as typeof spawn;

    const out = await new RawCommandAdapter({ groupSpawnFn }).run(
      ['mcp', 'list'],
      { processGroup: true },
    );

    expect(out).toBe('café');
  });

  it('kills the whole group when the deadline passes, and settles the read', async () => {
    // Owning the deadline is only safe because this timer does BOTH things:
    // reap the group (a grandchild that survives holds the inherited stdout
    // pipe open, so `close` never fires) and settle the promise, or the
    // service's in-flight slot for that folder is wedged for the daemon's life.
    vi.useFakeTimers();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      // Never emits — the wedged-grandchild case.
      const groupSpawnFn = (() =>
        fakeGroupChild(4242).child) as unknown as typeof spawn;

      const pending = new ClaudeAdapter({ groupSpawnFn }).listMcpServers(
        { cwd: '/tmp' },
        { timeoutMs: 50 },
      );
      await vi.advanceTimersByTimeAsync(50);

      // The group is ASKED to stop first — it may hold the user's own MCP
      // servers, which a straight SIGKILL would give no chance to shut down.
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(-4242, 'SIGKILL');

      // And this is the case the force-kill is FOR: no `exit` ever arrived, so
      // a grandchild is still holding the inherited stdout pipe open. Nothing
      // has waitpid'd the leader, so its pid cannot have been reissued.
      await vi.advanceTimersByTimeAsync(GROUP_KILL_GRACE_MS);
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

  it('still frees a grandchild that ignores SIGTERM, so a completed read is not thrown away', async () => {
    // The case reaping-at-`exit` exists for, spelled out at that listener: the
    // CLI is gone and has printed its whole answer, but a health-check
    // grandchild it forked still holds the inherited stdout pipe, so `close`
    // does not arrive. A grandchild that ignores SIGTERM — a browser server
    // mid-shutdown, an indexer — then keeps holding it, and with no escalation
    // the read sits until the 45s deadline and is discarded, reporting a
    // failure for a folder whose servers were read successfully.
    vi.useFakeTimers();
    const fake = fakeGroupChild(4260);
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((pid: number, signal?: string | number): true => {
        // Only a force-kill takes this grandchild down; the SIGTERM is ignored.
        if (pid === -4260 && signal === 'SIGKILL') {
          fake.child.emit('close', 0, null);
        }
        return true;
      });
    try {
      const groupSpawnFn = ((): unknown => {
        queueMicrotask(() => {
          fake.writeStdout('the whole listing\n');
          // `exit` alone: the leader is gone, the pipe is not.
          fake.child.emit('exit', 0, null);
        });
        return fake.child;
      }) as unknown as typeof spawn;

      const pending = new RawCommandAdapter({ groupSpawnFn }).run(
        ['mcp', 'list'],
        { processGroup: true, timeoutMs: 45_000 },
      );
      // Past the grace the escalation should have landed on, and on past the
      // whole deadline so the read settles either way rather than hanging.
      await vi.advanceTimersByTimeAsync(GROUP_KILL_GRACE_MS + 1);
      await vi.advanceTimersByTimeAsync(45_000);

      await expect(pending).resolves.toBe('the whole listing\n');
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reaps the group ONCE when the command answers, and never again after', async () => {
    // Two guarantees in one, because they pull against each other.
    //
    // The reap must HAPPEN on the success path: a listing command health-checks
    // the user's own MCP servers, and one that ignores stdin EOF outlives the
    // CLI (probe-verified on cursor-agent 2026.07.23-e383d2b — `mcp list`
    // exited 0 and left a child running). Once the CLI exits, `ProcessRegistry`
    // drops the handle, so this is the last moment anything can reach that
    // group.
    //
    // And it must happen exactly ONCE. `exit`, `close` and the deadline all
    // reap, and the timer is armed BEFORE the spawn (an injected spawn that
    // emits synchronously would otherwise leave one nothing can clear), so
    // settle has to clear it — else it fires later and signals whatever
    // process group owns that pid by then.
    vi.useFakeTimers();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      const groupSpawnFn = spawnAnswering('', 4243);

      await new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' });

      // ONE reap, which is ONE escalation: SIGTERM now…
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(-4243, 'SIGTERM');

      await vi.advanceTimersByTimeAsync(60_000);

      // …and its single SIGKILL after the grace, and nothing further. Two
      // signals from one reap, not two reaps: the deadline was cleared rather
      // than merely outrun, and `exit`/`close` did not each arm their own
      // escalation.
      expect(killSpy).toHaveBeenCalledTimes(2);
      expect(killSpy).toHaveBeenNthCalledWith(2, -4243, 'SIGKILL');
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('falls back to a direct kill when the group is already gone', async () => {
    // The ESRCH branch of `killProcessGroup`, and the only kill that lands
    // once the leader has exited. Every spec above stubs `process.kill` to
    // SUCCEED, so none of them enters it — a stub that throws is the only way
    // in, and without this the fallback ships unpinned and a later "this looks
    // like dead code" cleanup would silently drop the last reap.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((): never => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    try {
      const fake = fakeGroupChild(4249);
      const groupSpawnFn = ((): unknown => {
        queueMicrotask(() => fake.close(0));
        return fake.child;
      }) as unknown as typeof spawn;

      await new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' });

      expect(killSpy).toHaveBeenCalledWith(-4249, 'SIGTERM');
      expect(fake.directKills).toEqual(['SIGTERM']);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('reaps the group when the child fails instead of answering', async () => {
    // A spawn error (ENOENT surfaced asynchronously) settles the read, and the
    // group has to go with it — otherwise the grandchildren survive with the
    // timer already cleared and nothing left to reap them.
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      const fake = fakeGroupChild(4244);
      const groupSpawnFn = ((): unknown => {
        queueMicrotask(() => fake.fail());
        return fake.child;
      }) as unknown as typeof spawn;

      await new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' });

      expect(killSpy).toHaveBeenCalledWith(-4244, 'SIGTERM');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('reports a non-zero exit as unreadable rather than as empty output', async () => {
    // `execFile` gave us this for free via its `err` argument; the spawn path
    // has to read the exit code itself. Getting it wrong turns every failed
    // listing into a confident "this folder has no MCP servers".
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      const fake = fakeGroupChild(4250);
      const groupSpawnFn = ((): unknown => {
        queueMicrotask(() => {
          // A PARSEABLE payload, then a non-zero exit. With empty stdout this
          // assertion could not tell "we returned null" from "we returned ''",
          // and '' already parses to { ok: false } — so it passed with the
          // exit code ignored entirely, which is exactly the regression it
          // names. Returning the collected stdout here yields ok: true.
          fake.writeStdout('sentry: node s.js - √ Connected\n');
          fake.close(1);
        });
        return fake.child;
      }) as unknown as typeof spawn;

      await expect(
        new ClaudeAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/tmp' }),
      ).resolves.toMatchObject({ ok: false });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('reaps the group ONCE, even when the child exits after the deadline', async () => {
    // The deadline reaps and settles; the child's own `close` then arrives and
    // runs its own reap. By then node has waitpid'd the child, so a second
    // `kill(-pid)` can land on whatever now owns that pid.
    vi.useFakeTimers();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      const fake = fakeGroupChild(4248);
      const groupSpawnFn = (() => fake.child) as unknown as typeof spawn;

      // An EXPLICIT deadline, not the shipped constant: a bare literal that
      // has to match `CLAUDE_MCP_LIST_TIMEOUT_MS` goes vacuous the moment that
      // constant is retuned — the timer never fires and this stops testing the
      // ordering it names, silently.
      const pending = new ClaudeAdapter({ groupSpawnFn }).listMcpServers(
        { cwd: '/tmp' },
        { timeoutMs: 50 },
      );
      await vi.advanceTimersByTimeAsync(50); // deadline reaps + settles
      fake.close(0); // the child's own exit lands afterwards
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
    const adapter = new ClaudeAdapter({
      execFileFn,
      groupSpawnFn: spawnAnswering('', 4245),
    });

    await adapter.listMcpServers(
      { cwd: '/tmp' },
      { onSpawn: (_child, spawnInfo) => seen.push(spawnInfo) },
    );
    await adapter.supportsLiveStream({
      onSpawn: (_child, spawnInfo) => seen.push(spawnInfo),
    });

    expect(seen).toEqual([{ processGroup: true }, { processGroup: false }]);
  });

  it('leaves an ordinary utility command on execFile, undetached', async () => {
    // The default path is unchanged — every pre-existing caller (--version,
    // --help probes) must keep spawning exactly as it did, through execFile
    // with node's own deadline.
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

    await new ClaudeAdapter({ execFileFn }).supportsLiveStream();

    expect(opts.detached).toBeUndefined();
    expect(opts.timeout).toBe(10_000);
    expect(opts.cwd).toBeUndefined();
  });
});
