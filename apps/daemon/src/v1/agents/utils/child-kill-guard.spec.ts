import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  installChildKillGuard,
  KILL_GUARD_MARKER_FILE,
  KILL_GUARD_USER_BASH_ENV_ENV,
  KILL_GUARD_USER_ZDOTDIR_ENV,
  killGuardFiles,
  REAL_KILLS,
  withChildKillGuard,
  writeKillGuard,
} from './child-kill-guard';

// Every kill these specs let through lands in a recorder: the guard is
// generated with it in place of both the builtin and /bin/kill, each shell
// runs with its kill builtin disabled, and PATH holds nothing but the guard's
// shim and a few tools — so a broken guard can signal nothing.

const ZSH = '/bin/zsh';
const BASH = '/bin/bash';
const RECORDER_EXIT = 7;

const root = mkdtempSync(join(tmpdir(), 'kill-guard-spec-'));
const guardDir = join(root, 'Application Support', "it's guard");
const recorder = join(root, 'recorder.sh');
const recorded = join(root, 'recorded.log');
const tools = join(root, 'tools');
const home = join(root, 'home');
const kills = { builtin: [recorder], external: recorder };

function toolPath(name: string): string {
  const found = ['/usr/bin', '/bin']
    .map((dir) => join(dir, name))
    .find((path) => existsSync(path));
  if (found === undefined) {
    throw new Error(`${name} is missing: the kill guard spec needs it`);
  }
  return found;
}

const SAFE_PREAMBLE = {
  zsh: 'disable kill 2>/dev/null; ',
  bash: 'enable -n kill; ',
} as const;
type Shell = keyof typeof SAFE_PREAMBLE;
const SHELL_BINARY: Record<Shell, string> = { zsh: ZSH, bash: BASH };

let uninstall: () => void = () => undefined;

beforeAll(() => {
  for (const binary of [ZSH, BASH]) {
    if (!existsSync(binary)) {
      throw new Error(
        `${binary} is missing: the kill guard spec runs real shells`,
      );
    }
  }
  mkdirSync(tools, { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const name of ['xargs', 'env', 'cat']) {
    symlinkSync(toolPath(name), join(tools, name));
  }
  writeFileSync(
    recorder,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${recorded}'\nexit ${RECORDER_EXIT}\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  uninstall();
  rmSync(recorded, { force: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function guardedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  uninstall();
  uninstall = installChildKillGuard(guardDir, kills);
  return withChildKillGuard({ HOME: home, PATH: tools, ...extra });
}

function run(
  shell: Shell,
  line: string,
  options: { env?: NodeJS.ProcessEnv; flags?: string[]; safe?: boolean } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    SHELL_BINARY[shell],
    [
      ...(options.flags ?? ['-c']),
      (options.safe === false ? '' : SAFE_PREAMBLE[shell]) + line,
    ],
    {
      env: options.env ?? guardedEnv(),
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function recordedCalls(): string[] {
  return existsSync(recorded)
    ? readFileSync(recorded, 'utf8').trim().split('\n')
    : [];
}

const targets = (count: number): string =>
  Array.from({ length: count }, (_, i) => String(20000 + i)).join(' ');

describe.each(['zsh', 'bash'] as const)('kill guard in %s -c', (shell) => {
  beforeAll(() => {
    const line =
      shell === 'zsh' ? 'whence -ap kill; whence -w kill' : 'type -a kill';
    const reach = run(shell, line);
    expect(reach.status).toBe(0);
    const lines = reach.stdout.trim().split('\n');
    if (shell === 'zsh') {
      expect(lines).toEqual([join(guardDir, 'bin', 'kill'), 'kill: function']);
    } else {
      expect(lines[0]).toBe('kill is a function');
      expect(lines.at(-1)).toBe(`kill is ${join(guardDir, 'bin', 'kill')}`);
      expect(reach.stdout).toContain(recorder);
      expect(reach.stdout).not.toContain('shell builtin');
      expect(lines.filter((l) => l.startsWith('kill is /'))).toEqual([
        `kill is ${join(guardDir, 'bin', 'kill')}`,
      ]);
    }
  });

  it.each([
    ['kill -9 1', 'target 1 is launchd'],
    ['kill -KILL -1', 'target -1 signals every process you own'],
    ['kill -- -1', 'target -1 signals every process you own'],
    ['kill -s KILL -- -1', 'target -1 signals every process you own'],
    ['kill -n 9 -1', 'target -1 signals every process you own'],
    ['kill -9 -- 1', 'target 1 is launchd'],
    ['kill -- 0', "target 0 signals this shell's whole process group"],
    ['kill -9 -0', "target -0 signals this shell's whole process group"],
    ['kill 0', "target 0 signals this shell's whole process group"],
    ['kill -s KILL 01', 'target 01 is launchd'],
    ['kill -9 +1', 'target +1 is launchd'],
    ['kill -9 -01', 'target -01 signals every process you own'],
    ['l=$(printf "%s\\n" 105 1 200); kill -KILL $l', 'target 1 is launchd'],
    ['l="105 1 200"; kill -KILL "$l"', 'target 1 is launchd'],
    [`kill -9 ${targets(61)}`, '61 targets in one kill (limit 60)'],
    [`l="${targets(61)}"; kill -9 $l`, '61 targets in one kill (limit 60)'],
    ['command kill -9 1', 'target 1 is launchd'],
    ['printf "105\\n1\\n" | xargs kill -9', 'target 1 is launchd'],
    ['env kill -9 -1', 'target -1 signals every process you own'],
  ])('refuses %s before anything is signalled', (line, reason) => {
    const result = run(shell, line);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`geniro: refused kill: ${reason}`);
    expect(recordedCalls()).toEqual([]);
  });

  it.each([
    [`kill -9 ${targets(60)}`, `-9 ${targets(60)}`],
    ['kill -TERM 23456', '-TERM 23456'],
    ['kill -9 -23456', '-9 -23456'],
    ['kill %1', '%1'],
    ['kill -l', '-l'],
    ['kill -L', '-L'],
    ['kill -1 23456', '-1 23456'],
    ['kill -0 1', '-0 1'],
    ['kill -s 0 -1', '-s 0 -1'],
    [`kill -0 ${targets(61)}`, `-0 ${targets(61)}`],
    ['command kill -TERM 23456', '-TERM 23456'],
  ])('passes %s through unchanged, exit status included', (line, args) => {
    const result = run(shell, line);

    expect(result.status).toBe(RECORDER_EXIT);
    expect(result.stderr).toBe('');
    expect(recordedCalls()).toEqual([args]);
  });

  it('passes a short list from xargs through to the external kill', () => {
    const result = run(shell, 'printf "23456\\n" | xargs kill -TERM');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('');
    expect(recordedCalls()).toEqual(['-TERM 23456']);
  });
});

describe('kill guard in login shells', () => {
  it.each([
    [
      'zsh',
      '[[ $functions[kill] == *kill-check* ]] && print guarded || print unguarded; print -r -- $path[1]',
      'guarded',
    ],
    ['bash', 'type -t kill; printf "%s\\n" "${PATH%%:*}"', 'function'],
  ] as const)(
    '%s -l still resolves kill to the guard with its shim first on PATH',
    (shell, line, kind) => {
      const result = run(shell, line, { flags: ['-l', '-c'], safe: false });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().split('\n')).toEqual([
        kind,
        join(guardDir, 'bin'),
      ]);
    },
  );
});

describe("the user's own startup files", () => {
  const userConfig = join(home, 'config');

  beforeAll(() => {
    mkdirSync(userConfig, { recursive: true });
    writeFileSync(
      join(home, '.zshenv'),
      'export SEEN_ZDOTDIR="$ZDOTDIR"\nexport FROM_USER_ZSHENV=1\n',
    );
    writeFileSync(join(home, '.zprofile'), 'export FROM_USER_ZPROFILE=1\n');
    writeFileSync(join(userConfig, '.zshenv'), 'export FROM_CONFIG_ZSHENV=1\n');
    writeFileSync(
      join(userConfig, '.zprofile'),
      'export FROM_CONFIG_ZPROFILE=1\nkill() { echo user-kill; }\n',
    );
    writeFileSync(join(home, 'bash-env'), 'export FROM_USER_BASH_ENV=1\n');
  });

  it("sources the user's .zshenv and .zprofile under the user's own ZDOTDIR", () => {
    const result = run(
      'zsh',
      'print -r -- "$FROM_USER_ZSHENV $FROM_USER_ZPROFILE $SEEN_ZDOTDIR"; [[ $functions[kill] == *kill-check* ]] && print guarded || print unguarded',
      { flags: ['-l', '-c'], safe: false },
    );

    expect(result.stdout.trim().split('\n')).toEqual([
      `1 1 ${home}`,
      'guarded',
    ]);
  });

  it("follows a ZDOTDIR the user's own environment names, and guards again after the user's own kill", () => {
    const env = guardedEnv({ ZDOTDIR: userConfig });

    const result = run(
      'zsh',
      'print -r -- "$FROM_CONFIG_ZSHENV $FROM_CONFIG_ZPROFILE $ZDOTDIR"; [[ $functions[kill] == *kill-check* ]] && print guarded || print unguarded',
      { env, flags: ['-l', '-c'], safe: false },
    );

    expect(env[KILL_GUARD_USER_ZDOTDIR_ENV]).toBe(userConfig);
    expect(result.stdout.trim().split('\n')).toEqual([
      `1 1 ${guardDir}`,
      'guarded',
    ]);
  });

  it("follows a ZDOTDIR the user's .zshenv moves to", () => {
    writeFileSync(join(home, '.zshenv'), `export ZDOTDIR='${userConfig}'\n`);
    try {
      const result = run(
        'zsh',
        'print -r -- "$FROM_CONFIG_ZPROFILE"; [[ $functions[kill] == *kill-check* ]] && print guarded || print unguarded',
        { flags: ['-l', '-c'], safe: false },
      );

      expect(result.stdout.trim().split('\n')).toEqual(['1', 'guarded']);
    } finally {
      writeFileSync(
        join(home, '.zshenv'),
        'export SEEN_ZDOTDIR="$ZDOTDIR"\nexport FROM_USER_ZSHENV=1\n',
      );
    }
  });

  it("sources the user's own BASH_ENV first", () => {
    const env = guardedEnv({ BASH_ENV: join(home, 'bash-env') });

    const result = run('bash', 'echo "$FROM_USER_BASH_ENV"; type -t kill', {
      env,
      safe: false,
    });

    expect(env[KILL_GUARD_USER_BASH_ENV_ENV]).toBe(join(home, 'bash-env'));
    expect(result.stdout.trim().split('\n')).toEqual(['1', 'function']);
  });
});

describe('a guard inside a guard', () => {
  const outerDir = join(root, 'outer guard');

  beforeAll(() => {
    writeKillGuard(outerDir, kills);
  });

  it("never records another guard as the user's ZDOTDIR or BASH_ENV", () => {
    const env = guardedEnv({
      ZDOTDIR: outerDir,
      BASH_ENV: join(outerDir, 'bash-env'),
      [KILL_GUARD_USER_ZDOTDIR_ENV]: join(home, 'config'),
    });

    expect(env.ZDOTDIR).toBe(guardDir);
    expect(env.BASH_ENV).toBe(join(guardDir, 'bash-env'));
    expect(env[KILL_GUARD_USER_ZDOTDIR_ENV]).toBe(join(home, 'config'));
    expect(KILL_GUARD_USER_BASH_ENV_ENV in env).toBe(false);
  });

  it.each([
    ['its own folder', () => guardDir],
    ['another guard', () => outerDir],
  ])('falls back to HOME when the carried ZDOTDIR is %s', (_, carried) => {
    const env = {
      ...guardedEnv(),
      [KILL_GUARD_USER_ZDOTDIR_ENV]: carried(),
      [KILL_GUARD_USER_BASH_ENV_ENV]: join(carried(), 'bash-env'),
    };

    const zsh = run(
      'zsh',
      'print -r -- "$FROM_USER_ZSHENV"; [[ $functions[kill] == *kill-check* ]] && print guarded || print unguarded',
      {
        env,
        safe: false,
      },
    );
    const bash = run('bash', 'type -t kill', { env, safe: false });

    expect(zsh.stdout.trim().split('\n')).toEqual(['1', 'guarded']);
    expect(bash.stdout.trim()).toBe('function');
  });
});

describe('the installed guard', () => {
  it('is rewritten by the next child env when its folder is removed', () => {
    guardedEnv();
    rmSync(guardDir, { recursive: true, force: true });

    const env = withChildKillGuard({ HOME: home, PATH: tools });

    expect(env.ZDOTDIR).toBe(guardDir);
    for (const name of Object.keys(killGuardFiles(guardDir, kills))) {
      expect(existsSync(join(guardDir, name))).toBe(true);
    }
    expect(existsSync(join(guardDir, KILL_GUARD_MARKER_FILE))).toBe(true);
  });

  it('adds nothing once uninstalled', () => {
    guardedEnv();
    uninstall();

    const env = withChildKillGuard({ HOME: home, PATH: tools });

    expect(env).toEqual({ HOME: home, PATH: tools });
  });

  it('leaves PATH unset when the child had none', () => {
    guardedEnv();

    const env = withChildKillGuard({ HOME: home });

    expect(env.ZDOTDIR).toBe(guardDir);
    expect('PATH' in env).toBe(false);
  });

  it('leaves the env as it was when the guard cannot be written', () => {
    const plainFile = join(root, 'plain-file');
    writeFileSync(plainFile, '');
    uninstall = installChildKillGuard(join(plainFile, 'guard'), kills);

    const env = withChildKillGuard({ HOME: home, PATH: tools });

    expect(env).toEqual({ HOME: home, PATH: tools });
  });

  it('leaves the env as it was, warning once, when a removed guard cannot be rewritten', () => {
    guardedEnv();
    rmSync(guardDir, { recursive: true, force: true });
    writeFileSync(guardDir, '');
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const first = withChildKillGuard({ HOME: home, PATH: tools });
      const second = withChildKillGuard({ HOME: home, PATH: tools });

      expect(first).toEqual({ HOME: home, PATH: tools });
      expect(second).toEqual({ HOME: home, PATH: tools });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      rmSync(guardDir, { force: true });
    }
  });

  it('hands a passing kill to the shell builtin and to /bin/kill in production', () => {
    const files = killGuardFiles(guardDir, REAL_KILLS);

    expect(existsSync('/bin/kill')).toBe(true);
    expect(files['bin/kill']?.content).toContain(`exec '/bin/kill' "$@"`);
    for (const name of ['kill-guard.zsh', 'bash-env']) {
      expect(files[name]?.content).toContain(
        `|| return 1; 'builtin' 'kill' "$@"`,
      );
    }
  });
});
