import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AgentSpawnInfo } from '../../agents/adapters/adapter.types';
import { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import { ModelVocabularyStore } from '../../agents/services/model-vocabulary.store';
import { AgentKind } from '../../runs/runs.types';
import { CliAuthService } from './cli-auth.service';

/**
 * A login child with the two streams the service reads and the stdin it writes.
 *
 * Local to this spec rather than in `__tests__/`: the shared `fake-child` doubles
 * model a TURN, and this one models a process whose stdout the service watches
 * while it stays alive — a shape no other spec needs.
 */
function fakeChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const writes: string[] = [];
  const child = {
    stdout,
    stderr,
    stdin: {
      destroyed: false,
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    },
    pid: 4242,
    once: () => child,
    kill: () => true,
  };
  return { child, stdout, stderr, writes };
}

const GROUP: AgentSpawnInfo = { processGroup: true };

/**
 * The service with a fake adapter and a real-shaped process registry.
 *
 * `exit` is how a spec ends the login: `runLogin` resolves with a string for a
 * clean exit and null otherwise, exactly as the adapter does.
 */
function build(
  overrides: {
    loginCodePromptMarkers?: readonly string[];
    loginArgs?: readonly string[] | null;
    logoutArgs?: readonly string[] | null;
    logoutOk?: boolean;
  } = {},
) {
  const fake = fakeChild();
  let settle: ((out: string | null) => void) | null = null;
  const auth = {
    loginArgs:
      overrides.loginArgs === undefined
        ? ['auth', 'login']
        : overrides.loginArgs,
    loginUnavailableReason: null,
    logoutArgs:
      overrides.logoutArgs === undefined
        ? ['auth', 'logout']
        : overrides.logoutArgs,
    logoutUnavailableReason: null,
    loginCodePromptMarkers: overrides.loginCodePromptMarkers ?? [
      'paste code here',
    ],
  };
  // Calls `onSpawn` like the real base does (it forwards it to `runCommand`), so
  // the spec can assert what the SERVICE passes rather than testing a double that
  // silently never offers a child to register.
  const runLogout = vi.fn(
    (options: { onSpawn?: (child: unknown, info: AgentSpawnInfo) => void }) => {
      options.onSpawn?.(fake.child, { processGroup: false });
      return Promise.resolve(overrides.logoutOk !== false);
    },
  );
  const adapter = {
    getConfig: () => ({
      auth,
      // The SERVER half of the same block. Present so `startMcpLogin` is
      // reachable from these specs at all — the double stands in for the whole
      // adapter, and the service reads both halves.
      mcp: { loginArgs: ['mcp', 'login'], loginUnavailableReason: null },
    }),
    runLogout,
    runMcpLogin: (options: {
      onSpawn: (child: unknown, info: AgentSpawnInfo) => void;
    }) => {
      options.onSpawn(fake.child, GROUP);
      return new Promise<string | null>((resolve) => {
        settle = resolve;
      });
    },
    // A CLI that declares no failure wording, which is cursor's real shape —
    // so a clean exit is the whole verdict.
    mcpLoginFailed: () => false,
    runLogin: (options: {
      onSpawn: (child: unknown, info: AgentSpawnInfo) => void;
    }) => {
      options.onSpawn(fake.child, GROUP);
      return new Promise<string | null>((resolve) => {
        settle = resolve;
      });
    },
    // Concrete on the real base over `loginCodePromptMarkers`; reproduced here
    // because the double stands in for the whole adapter.
    loginWantsCode: (output: string) =>
      auth.loginCodePromptMarkers.some((m) =>
        output.toLowerCase().includes(m.toLowerCase()),
      ),
  };
  const registered = new Map<string, { cancel: () => void }>();
  const processes = {
    register: (id: string, handle: { cancel: () => void }) =>
      registered.set(id, handle),
    cancel: (id: string) => {
      registered.get(id)?.cancel();
      return registered.delete(id);
    },
  };
  // Real, not a double: a completed SERVER sign-in retires that folder's agent
  // sessions, and the count it marks is what the tests below observe.
  const sessions = new AgentSessionRegistry();
  // Real too, over a temp file: what the sign-in flows must DROP is what this
  // store holds, and a double would only pin that a method was called.
  const storeDir = mkdtempSync(join(tmpdir(), 'cli-auth-vocab-'));
  const vocabularies = new ModelVocabularyStore({
    file: join(storeDir, 'model-vocabularies.json'),
  });
  const service = new CliAuthService(
    { for: () => adapter } as never,
    processes as never,
    sessions,
    vocabularies,
  );
  return {
    service,
    sessions,
    vocabularies,
    cleanup: () => rmSync(storeDir, { recursive: true, force: true }),
    fake,
    registered,
    runLogout,
    exit: (out: string | null) => settle?.(out),
  };
}

/** Let the queued microtasks/timers of the service's own polling run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('CliAuthService — sign-out', () => {
  it('runs the CLI and reports success, with no terminal involved', async () => {
    const { service, runLogout } = build();

    const result = await service.logout({ agent: AgentKind.Claude });

    expect(result).toEqual({
      agent: AgentKind.Claude,
      ok: true,
      unavailableReason: null,
    });
    // Ran, rather than resolved-for-a-terminal. This is the whole difference from
    // `HandoffService.logoutTarget`, which must never spawn.
    expect(runLogout).toHaveBeenCalled();
  });

  it('registers the child, so an abandoned sign-out still dies on shutdown', async () => {
    const { service, registered } = build();
    await service.logout({ agent: AgentKind.Claude });

    // The rule has no short-lived exemption; this is the assertion that enters
    // the `onSpawn` branch rather than trusting it exists.
    expect(
      [...registered.keys()].some((k) => k.startsWith('auth:logout:')),
    ).toBe(true);
  });

  it('answers a CLI with no sign-out command as a refusal, not a crash', async () => {
    const { service, runLogout } = build({ logoutArgs: null });

    const result = await service.logout({ agent: AgentKind.Claude });

    expect(result.ok).toBe(false);
    expect(result.unavailableReason).toContain('no sign-out command');
    expect(runLogout).not.toHaveBeenCalled();
  });

  it('reports a failed sign-out rather than claiming it worked', async () => {
    const { service } = build({ logoutOk: false });

    const result = await service.logout({ agent: AgentKind.Claude });

    expect(result.ok).toBe(false);
    expect(result.unavailableReason).toContain('terminal');
  });
});

describe('CliAuthService — sign-in', () => {
  it('surfaces the URL the CLI printed, and keeps waiting', async () => {
    const { service, fake } = build();
    const started = service.startLogin({ agent: AgentKind.Claude });
    fake.stdout.emit(
      'data',
      "Opening browser…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=abc\n",
    );

    const session = await started;

    expect(session.url).toBe(
      'https://claude.com/cai/oauth/authorize?state=abc',
    );
    expect(session.status).toBe('waiting');
  });

  it('registers the login child under its own id', async () => {
    const { service, fake, registered } = build();
    const started = service.startLogin({ agent: AgentKind.Claude });
    fake.stdout.emit('data', 'visit https://x.test/a\n');
    const session = await started;

    expect(registered.has(`auth:login:${session.id}`)).toBe(true);
  });

  it('asks for a code only once the CLI has actually prompted', async () => {
    const { service, fake } = build();
    const started = service.startLogin({ agent: AgentKind.Claude });
    fake.stdout.emit('data', 'visit https://x.test/a\n');
    const session = await started;
    expect(service.status(session.id).status).toBe('waiting');

    fake.stdout.emit('data', 'Paste code here if prompted > ');

    expect(service.status(session.id).status).toBe('needs_code');
  });

  it('never asks for a code from a CLI that declares no prompt', async () => {
    // cursor's shape: it polls to completion. Its real output is fed in verbatim,
    // so an over-eager marker in the shared path would fail here.
    const { service, fake } = build({ loginCodePromptMarkers: [] });
    const started = service.startLogin({ agent: AgentKind.CursorAgent });
    fake.stdout.emit(
      'data',
      'Starting login process...\nWaiting for browser authentication...\nOpen a browser and navigate to this link: https://cursor.com/login?uuid=1\n',
    );
    const session = await started;

    expect(session.status).toBe('waiting');
    expect(session.url).toBe('https://cursor.com/login?uuid=1');
  });

  it('holds needs_code across later output, so a filled field cannot vanish', async () => {
    const { service, fake } = build();
    const started = service.startLogin({ agent: AgentKind.Claude });
    fake.stdout.emit('data', 'Paste code here > ');
    const session = await started;
    expect(session.status).toBe('needs_code');

    // A CLI that keeps writing (a spinner, a hint) must not drop the state back:
    // the user may be mid-paste, and the field would disappear under them.
    fake.stdout.emit('data', 'still waiting…\n');

    expect(service.status(session.id).status).toBe('needs_code');
  });

  it('writes a submitted code to the CLI and goes back to waiting', async () => {
    const { service, fake } = build();
    const started = service.startLogin({ agent: AgentKind.Claude });
    fake.stdout.emit('data', 'Paste code here > ');
    const session = await started;

    const after = service.submitCode(session.id, '  code-123  ');

    // Trimmed and newline-terminated — the CLI is reading a line.
    expect(fake.writes).toEqual(['code-123\n']);
    // `waiting`, not `succeeded`: whether it was the RIGHT code is the CLI's
    // answer to give by exiting.
    expect(after.status).toBe('waiting');
  });

  it('refuses a code the CLI never asked for', async () => {
    // The defensive branch, entered deliberately. A write into the stdin of a
    // process that is polling a browser is swallowed, and the user would be left
    // believing they had answered something.
    const { service, fake } = build({ loginCodePromptMarkers: [] });
    const started = service.startLogin({ agent: AgentKind.CursorAgent });
    fake.stdout.emit('data', 'visit https://x.test/a\n');
    const session = await started;

    expect(() => service.submitCode(session.id, 'code')).toThrow(
      /not waiting for a code/,
    );
    expect(fake.writes).toEqual([]);
  });

  it('reports a clean exit as succeeded — a claim about the COMMAND, not the account', async () => {
    const { service, fake, exit } = build();
    const started = service.startLogin({ agent: AgentKind.Claude });
    fake.stdout.emit('data', 'visit https://x.test/a\n');
    const session = await started;

    exit('done');
    await tick();

    expect(service.status(session.id).status).toBe('succeeded');
  });

  it('reports a non-zero exit as failed, keeping the CLI’s last line', async () => {
    const { service, fake, exit } = build();
    const started = service.startLogin({ agent: AgentKind.Claude });
    fake.stdout.emit('data', 'visit https://x.test/a\nOAuth failed\n');
    const session = await started;

    exit(null);
    await tick();

    const settled = service.status(session.id);
    expect(settled.status).toBe('failed');
    expect(settled.message).toBe('OAuth failed');
  });

  it('cancel reaps the group and sticks, even if the child exits afterwards', async () => {
    const { service, fake, exit } = build();
    const started = service.startLogin({ agent: AgentKind.Claude });
    fake.stdout.emit('data', 'visit https://x.test/a\n');
    const session = await started;

    expect(service.cancelLogin(session.id).status).toBe('cancelled');

    // The reaped child then resolves. Overwriting `cancelled` with `failed` here
    // would report the user's own cancel as an error.
    exit(null);
    await tick();
    expect(service.status(session.id).status).toBe('cancelled');
  });

  it('refuses to start for a CLI with no sign-in command', async () => {
    const { service } = build({ loginArgs: null });

    await expect(
      service.startLogin({ agent: AgentKind.Claude }),
    ).rejects.toThrow(/no sign-in command/);
  });

  it('404s an unknown sign-in id rather than inventing a state', () => {
    const { service } = build();

    expect(() => service.status('nope')).toThrow(/no sign-in/);
  });
});

describe('CliAuthService — a server sign-in that landed', () => {
  it('retires that folder’s agent sessions, so the next turn sees the connector', async () => {
    // THE REPORTED DEFECT, from the sign-in side: the user connected Linear and
    // the chat's next turn still had only the servers its CLI process read at
    // spawn. The agent itself wrote "the connector may need the session
    // restarted" — this is that restart, deferred to the next turn.
    const { service, fake, exit, sessions } = build();
    const marked = vi.spyOn(sessions, 'markStale');
    const started = service.startMcpLogin({
      agent: AgentKind.Claude,
      server: 'linear',
      cwd: process.cwd(),
    });
    fake.stdout.emit('data', 'visit https://x.test/a\n');
    await started;

    exit('done');
    await tick();

    expect(marked).toHaveBeenCalledWith(
      AgentKind.Claude,
      // The CANONICAL path, which is what a turn records — a raw one would
      // match nothing on a machine whose tmp dir is behind a symlink.
      realpathSync(process.cwd()),
      expect.stringContaining('linear'),
    );
  });

  it('retires nothing when the sign-in did NOT complete', async () => {
    // A failed sign-in changed nothing, and respawning a working chat's CLI
    // over it costs the user their warm process for no gain.
    const { service, fake, exit, sessions } = build();
    const marked = vi.spyOn(sessions, 'markStale');
    const started = service.startMcpLogin({
      agent: AgentKind.Claude,
      server: 'linear',
      cwd: process.cwd(),
    });
    fake.stdout.emit('data', 'visit https://x.test/a\n');
    await started;

    exit(null);
    await tick();

    expect(marked).not.toHaveBeenCalled();
  });

  it('retires nothing for an ACCOUNT sign-in, which is not folder-scoped', async () => {
    // `cwd` is null there, and marking every folder would respawn chats whose
    // MCP configuration did not move.
    const { service, fake, exit, sessions } = build();
    const marked = vi.spyOn(sessions, 'markStale');
    const started = service.startLogin({ agent: AgentKind.Claude });
    fake.stdout.emit('data', 'visit https://x.test/a\n');
    await started;

    exit('done');
    await tick();

    expect(marked).not.toHaveBeenCalled();
  });
});

describe('CliAuthService — what an account change invalidates', () => {
  const VERSION = '2.1.237';
  const MODELS = [{ id: 'opus', label: 'Opus' }];

  it('drops that CLI’s cached vocabularies when an ACCOUNT sign-in lands', async () => {
    // The exact half of the staleness story. A subscription decides which
    // models exist and what each offers, and none of that moves the CLI's
    // `--version` — the only other check a stored answer is held to — so
    // without this the composer would go on offering the previous account's
    // models until the refresh window lapsed.
    const { service, fake, exit, vocabularies, cleanup } = build();
    vocabularies.remember(AgentKind.Claude, null, VERSION, MODELS);
    const started = service.startLogin({ agent: AgentKind.Claude });
    fake.stdout.emit('data', 'visit https://x.test/a\n');
    await started;

    exit('done');
    await tick();

    expect(
      vocabularies.read(AgentKind.Claude, null, VERSION, isModelRows),
    ).toBeNull();
    cleanup();
  });

  it('drops them on a completed sign-OUT too', async () => {
    const { service, vocabularies, cleanup } = build();
    vocabularies.remember(AgentKind.Claude, null, VERSION, MODELS);

    await service.logout({ agent: AgentKind.Claude });

    expect(
      vocabularies.read(AgentKind.Claude, null, VERSION, isModelRows),
    ).toBeNull();
    cleanup();
  });

  it('keeps them when the sign-in did NOT complete', async () => {
    // A sign-in that failed changed no account, so discarding the vocabulary
    // would buy a cold six-second re-ask and nothing else.
    const { service, fake, exit, vocabularies, cleanup } = build();
    vocabularies.remember(AgentKind.Claude, null, VERSION, MODELS);
    const started = service.startLogin({ agent: AgentKind.Claude });
    fake.stdout.emit('data', 'visit https://x.test/a\n');
    await started;

    exit(null);
    await tick();

    expect(
      vocabularies.read(AgentKind.Claude, null, VERSION, isModelRows)?.value,
    ).toEqual(MODELS);
    cleanup();
  });

  it('keeps them for a SERVER sign-in, which changes tools and not models', async () => {
    const { service, fake, exit, vocabularies, cleanup } = build();
    vocabularies.remember(AgentKind.Claude, null, VERSION, MODELS);
    const started = service.startMcpLogin({
      agent: AgentKind.Claude,
      server: 'linear',
      cwd: process.cwd(),
    });
    fake.stdout.emit('data', 'visit https://x.test/a\n');
    await started;

    exit('done');
    await tick();

    expect(
      vocabularies.read(AgentKind.Claude, null, VERSION, isModelRows)?.value,
    ).toEqual(MODELS);
    cleanup();
  });
});

/** The shape guard the store takes — the models listing's, in miniature. */
function isModelRows(value: unknown): value is { id: string; label: string }[] {
  return Array.isArray(value);
}
