import type { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SpawnedProcess, SpawnFn } from '../../utils/spawn-cli';
import type { AdapterConfig, AgentEvent } from '../adapter.types';
import { CursorAdapter } from './cursor.adapter';

class FakeReadable extends EventEmitter {
  setEncoding(): this {
    return this;
  }
  emitData(chunk: string): void {
    this.emit('data', chunk);
  }
}
class FakeWritable extends EventEmitter {
  written = '';
  write(chunk: string): boolean {
    this.written += chunk;
    return true;
  }
  end(): this {
    return this;
  }
}
class FakeChild extends EventEmitter {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin = new FakeWritable();
  kill(): boolean {
    return true;
  }
}

function fakeSpawn(): {
  spawn: SpawnFn;
  child: FakeChild;
  captured: { command?: string; args?: string[] };
} {
  const child = new FakeChild();
  const captured: { command?: string; args?: string[] } = {};
  const spawn: SpawnFn = (command, args) => {
    captured.command = command;
    captured.args = args;
    return child as unknown as SpawnedProcess;
  };
  return { spawn, child, captured };
}

describe('CursorAdapter', () => {
  it('has no way to ask the user anything, and ignores a turn that wants one', () => {
    // The adapter rule at work: the caller asks uniformly for the question
    // channel and THIS CLI answers "I have none" — so no service ever needs to
    // know which agent it is talking to. cursor-agent has no per-turn approval
    // channel at all, so allowUserQuestions must not change a single flag.
    expect(new CursorAdapter().getConfig().questionToolName).toBeNull();

    const plain = fakeSpawn();
    new CursorAdapter({ spawn: plain.spawn }).start(
      { prompt: 'p', cwd: '/proj', approvalMode: 'auto' },
      () => {},
    );
    const asking = fakeSpawn();
    new CursorAdapter({ spawn: asking.spawn }).start(
      {
        prompt: 'p',
        cwd: '/proj',
        approvalMode: 'auto',
        allowUserQuestions: true,
      },
      () => {},
    );

    expect(asking.captured.args).toEqual(plain.captured.args);
  });

  it('honours only auto, and REPORTS anything else rather than ignoring it', () => {
    // The same rule again: a workflow node may be authored 'ask' (the graph
    // schema is CLI-agnostic), and this CLI's honest answer is "that becomes
    // auto, and here is the line to show the user" — never a silent swap.
    const adapter = new CursorAdapter();
    expect(adapter.getConfig().approval.modes).toEqual(['auto']);
    expect(adapter.getConfig().approval.probedModes).toEqual([]);

    expect(adapter.resolveApprovalMode('auto', { supported: {} })).toEqual({
      mode: 'auto',
      degradeReason: null,
    });
    for (const requested of ['ask', 'acceptEdits', 'plan'] as const) {
      const resolved = adapter.resolveApprovalMode(requested, {
        supported: {},
      });
      expect(resolved.mode).toBe('auto');
      expect(resolved.degradeReason).toContain(
        `approval '${requested}' degrades to auto-approve`,
      );
    }
  });

  it('needs a machine trust probe and a cwd config file before it can call', () => {
    // Both true because of how cursor-agent takes an MCP server at all: a
    // persistent trust store to satisfy, and no per-turn --mcp-config flag.
    const adapter = new CursorAdapter();
    expect(adapter.getConfig().mcp.callToolsRequireTrustProbe).toBe(true);
    expect(adapter.getConfig().mcp.endpointRequiresCwdConfig).toBe(true);
  });

  it('has no reasoning-effort control, and a turn carrying one adds no flag', () => {
    // Same rule as config.questionToolName above: the caller asks uniformly
    // and this CLI answers "none" — effort is folded into its model ids
    // instead.
    expect(new CursorAdapter().listEfforts()).toEqual([]);

    const plain = fakeSpawn();
    new CursorAdapter({ spawn: plain.spawn }).start(
      { prompt: 'p', cwd: '/proj' },
      () => {},
    );
    const withEffort = fakeSpawn();
    new CursorAdapter({ spawn: withEffort.spawn }).start(
      { prompt: 'p', cwd: '/proj', effort: 'high' },
      () => {},
    );

    expect(withEffort.captured.args).toEqual(plain.captured.args);
    expect(withEffort.captured.args).not.toContain('--effort');
  });

  it('delivers the prompt on stdin — never on ps-visible argv — and streams a turn', async () => {
    const { spawn, child, captured } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new CursorAdapter({ spawn }).start(
      { prompt: 'list files', cwd: '/proj' },
      (e) => events.push(e),
    );

    child.stdout.emitData('{"type":"system","chatId":"c-1"}\n');
    child.stdout.emitData('{"type":"assistant","text":"done"}\n');
    child.stdout.emitData('{"type":"result","is_error":false}\n');
    child.emit('close', 0, null);
    await handle.done;

    expect(captured.command).toBe('cursor-agent');
    expect(captured.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--force',
      ]),
    );
    // argv is readable by any local account via ps; the prompt (user task
    // text + upstream node outputs) must ride stdin instead.
    expect(captured.args).not.toContain('list files');
    expect(child.stdin.written).toBe('list files');
    expect(events).toEqual([
      { type: 'session', sessionId: 'c-1' },
      { type: 'text', text: 'done' },
      {
        type: 'turn_complete',
        usage: {
          inputTokens: null,
          outputTokens: null,
          contextTokens: null,
          contextWindowTokens: null,
          costUsd: null,
        },
        stopReason: null,
        finalText: null,
      },
    ]);
  });

  it('passes --resume with the prior chat id', () => {
    const { spawn, captured } = fakeSpawn();
    new CursorAdapter({ spawn }).start(
      { prompt: 'go', cwd: '/proj', resumeSessionId: 'c-prev' },
      () => {},
    );
    expect(captured.args).toEqual(
      expect.arrayContaining(['--resume', 'c-prev']),
    );
  });

  it('a dash-leading prompt can never be parsed as a CLI flag — it rides stdin', () => {
    const { spawn, child, captured } = fakeSpawn();
    new CursorAdapter({ spawn }).start(
      { prompt: '--help', cwd: '/proj' },
      () => {},
    );
    expect(captured.args).not.toContain('--help');
    expect(child.stdin.written).toBe('--help');
  });

  it('fails fast with an error event on a non-zero exit', async () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new CursorAdapter({ spawn }).start(
      { prompt: 'go', cwd: '/proj' },
      (e) => events.push(e),
    );
    child.stderr.emitData('not logged in');
    child.emit('close', 1, null);
    await handle.done;

    expect(events).toEqual([
      {
        type: 'error',
        message: 'cursor-agent exited with code 1: not logged in',
      },
    ]);
  });
});

describe('CursorAdapter graph-node extras', () => {
  it('prepends the system prompt to the stdin prompt (no CLI flag exists)', () => {
    const { spawn, child, captured } = fakeSpawn();
    new CursorAdapter({ spawn }).start(
      {
        prompt: 'review the diff',
        cwd: '/proj',
        systemPrompt: 'You are the reviewer.',
        approvalMode: 'ask',
      },
      () => {},
    );
    expect(child.stdin.written).toBe(
      'You are the reviewer.\n\nreview the diff',
    );
    // The role text is part of the prompt payload — it stays off argv too.
    expect(captured.args!.some((a) => a.includes('reviewer'))).toBe(false);
    // ask degrades to --force (auto-approve) — cursor-agent has no callback.
    expect(captured.args).toEqual(expect.arrayContaining(['--force']));
  });

  it('names attached image paths in the prompt, keeping the role prefix outermost', () => {
    // cursor's stdin is a plain prompt string with no content-block channel,
    // so a path is the only way to hand it an image. The role must still come
    // first — it frames everything after it, attachments included.
    const { spawn, child, captured } = fakeSpawn();
    new CursorAdapter({ spawn }).start(
      {
        prompt: 'what is wrong here?',
        cwd: '/proj',
        systemPrompt: 'You are the reviewer.',
        images: [{ path: '/data/att/run/a.png', mediaType: 'image/png' }],
      },
      () => {},
    );

    expect(child.stdin.written).toBe(
      'You are the reviewer.\n\nThe user attached this image file:\n' +
        '- /data/att/run/a.png\n\nwhat is wrong here?',
    );
    // The path rides stdin like the rest of the prompt — never argv.
    expect(captured.args!.some((a) => a.includes('a.png'))).toBe(false);
  });

  it('degrades every non-auto approval mode to --force (no approval callback)', () => {
    for (const mode of ['ask', 'acceptEdits', 'plan'] as const) {
      const { spawn, captured } = fakeSpawn();
      new CursorAdapter({ spawn }).start(
        { prompt: 'p', cwd: '/proj', approvalMode: mode },
        () => {},
      );
      expect(captured.args).toEqual(expect.arrayContaining(['--force']));
      expect(captured.args).not.toEqual(
        expect.arrayContaining(['--permission-mode']),
      );
    }
  });

  it('passes --trust only when the turn sets trustWorkspace', () => {
    const plain = fakeSpawn();
    new CursorAdapter({ spawn: plain.spawn }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    expect(plain.captured.args).not.toEqual(
      expect.arrayContaining(['--trust']),
    );

    const trusted = fakeSpawn();
    new CursorAdapter({ spawn: trusted.spawn }).start(
      { prompt: 'go', cwd: '/probe-tmp', trustWorkspace: true },
      () => {},
    );
    expect(trusted.captured.args).toEqual(expect.arrayContaining(['--trust']));
    // Blanket approval must never ride the argv — approval stays scoped to
    // the geniro entry's autoApprove + `mcp enable geniro`.
    expect(trusted.captured.args).not.toContain('--approve-mcps');
  });
});

describe('CursorAdapter binary override', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('spawns the GENIRO_CURSOR_BIN override instead of the bare binary', () => {
    vi.stubEnv('GENIRO_CURSOR_BIN', '/opt/tools/cursor-agent');
    const { spawn, captured } = fakeSpawn();
    new CursorAdapter({ spawn }).start({ prompt: 'p', cwd: '/proj' }, () => {});
    expect(captured.command).toBe('/opt/tools/cursor-agent');
  });
});

describe('CursorAdapter model listing', () => {
  /** Capture the utility command and answer it with canned stdout. */
  function fakeExec(stdout: string | null): {
    execFileFn: typeof execFile;
    captured: { args?: string[] };
  } {
    const captured: { args?: string[] } = {};
    const execFileFn = ((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, out: string) => void,
    ) => {
      captured.args = args;
      cb(stdout === null ? new Error('spawn failed') : null, stdout ?? '');
      return { on: () => {} };
    }) as unknown as typeof execFile;
    return { execFileFn, captured };
  }

  it('asks the CLI and returns exactly what it reported', async () => {
    // `cursor-agent models` is the ONE CLI here that can be asked, so the list
    // is live — a model the account gains shows up with no app change.
    const { execFileFn, captured } = fakeExec('gpt-5.2-high\nsonnet-4.6\n');

    const models = await new CursorAdapter({ execFileFn }).listModels();

    expect(captured.args).toEqual(['models']);
    expect(models.map((model) => model.id)).toEqual([
      'gpt-5.2-high',
      'sonnet-4.6',
    ]);
    expect(models.every((model) => model.source === 'cli')).toBe(true);
  });

  it('falls back to the documented ids when the CLI cannot answer', async () => {
    // An install predating the `models` subcommand treats it as a prompt and
    // drops into sign-in; the picker must still offer something usable.
    const { execFileFn } = fakeExec(null);

    const models = await new CursorAdapter({ execFileFn }).listModels();

    expect(models.map((model) => model.id)).toEqual([
      'gpt-5',
      'sonnet-4',
      'sonnet-4-thinking',
    ]);
    expect(models.every((model) => model.source === 'builtin')).toBe(true);
  });

  it('falls back to the set its CONFIG declares, not the shipped ids', async () => {
    // `config.builtinModels` is documented as THE fallback contract — "what a
    // CLI that cannot be asked answers with so the picker is never empty" — so
    // it must be what listModels actually reads. An adapter whose config
    // carries a different floor answers with THAT floor; hardcoding the
    // documented example ids in listModels instead would leave the field
    // write-only, and this test is the thing that fails when someone does.
    class ConfiguredCursorAdapter extends CursorAdapter {
      override getConfig(): AdapterConfig {
        return {
          ...super.getConfig(),
          builtinModels: [
            {
              id: 'pinned-floor-model',
              label: 'Pinned floor',
              source: 'builtin',
            },
          ],
        };
      }
    }
    const { execFileFn } = fakeExec(null);

    const models = await new ConfiguredCursorAdapter({
      execFileFn,
    }).listModels();

    expect(models).toEqual([
      { id: 'pinned-floor-model', label: 'Pinned floor', source: 'builtin' },
    ]);
  });

  it('falls back when the CLI says the account has no models', async () => {
    const { execFileFn } = fakeExec('No models available for this account.');

    const models = await new CursorAdapter({ execFileFn }).listModels();

    expect(models.every((model) => model.source === 'builtin')).toBe(true);
  });
});

describe('CursorAdapter — installed approval support', () => {
  it('reads NOTHING from the capability bag, whatever claude probed', () => {
    // The fold's whole point: the bag is shared, but each adapter takes only
    // its own slice. Handing cursor a bag in which claude's probe FAILED must
    // not make cursor report a mode as unsupported — it has no probed mode at
    // all, and an absent verdict is not a negative one.
    expect(
      new CursorAdapter().approvalSupportFrom({
        claudeModes: {
          acceptEdits: 'fail',
          plan: 'fail',
          reason: 'claude rejected both',
        },
      }),
    ).toEqual({ supported: {} });
  });
});

describe('CursorAdapter — commands on disk', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function writeCommand(
    root: string,
    agentDir: string,
    relPath: string,
    content: string,
  ): void {
    const path = join(root, agentDir, 'commands', relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function build(): { cwd: string; homeDir: string } {
    return { cwd: tempDir('cursor-cwd-'), homeDir: tempDir('cursor-home-') };
  }

  it('scans .cursor/commands from the project folder and from ~', async () => {
    const { cwd, homeDir } = build();
    writeCommand(cwd, '.cursor', 'fix.md', 'Fix the thing.');
    writeCommand(homeDir, '.cursor', 'home-cmd.md', 'From home.');

    expect(await new CursorAdapter().listSkills({ cwd, homeDir })).toEqual([
      {
        name: 'fix',
        description: 'Fix the thing.',
        kind: 'command',
        source: 'project',
      },
      {
        name: 'home-cmd',
        description: 'From home.',
        kind: 'command',
        source: 'user',
      },
    ]);
  });

  it('never reads claude roots — .claude belongs to the other CLI', async () => {
    const { cwd, homeDir } = build();
    const skillDir = join(cwd, '.claude', 'skills', 'deploy');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: deploy\n---\n');
    writeCommand(cwd, '.claude', 'review.md', 'Review.');
    writeCommand(cwd, '.cursor', 'fix.md', 'Fix the thing.');

    const found = await new CursorAdapter().listSkills({ cwd, homeDir });
    expect(found.map((entry) => entry.name)).toEqual(['fix']);
  });

  it('has no skills convention — every entry is a command', async () => {
    // `config.skillRoots.skills: []` is the declared fact, so the base scans
    // no skills root for this CLI at all.
    const { cwd, homeDir } = build();
    writeCommand(cwd, '.cursor', 'fix.md', 'Fix the thing.');
    // A cursor "skills" directory is not a thing the CLI reads.
    const skillDir = join(cwd, '.cursor', 'skills', 'deploy');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: deploy\n---\n');

    const found = await new CursorAdapter().listSkills({ cwd, homeDir });
    expect(found.map((entry) => entry.name)).toEqual(['fix']);
    expect(found.every((entry) => entry.kind === 'command')).toBe(true);
  });

  it('returns [] when the folder has no .cursor/commands at all', async () => {
    const { cwd, homeDir } = build();
    await expect(
      new CursorAdapter().listSkills({ cwd, homeDir }),
    ).resolves.toEqual([]);
  });
});

describe('CursorAdapter — the interactive terminal mirror', () => {
  it('refuses a mirror outright — cursor-agent has no resumable TUI (deferred scope)', () => {
    // `terminal: null` in cursor.const.ts IS the deferred-scope statement. It
    // must answer `unsupported` even WITH a well-shaped session id: handing
    // cursor claude's resume argv would open a broken (or unrelated) TUI, and
    // the consumer's HTTP code for "never" differs from "not yet".
    expect(new CursorAdapter().terminalCommand('sess-42')).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });
});
