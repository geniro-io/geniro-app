import { describe, expect, it } from 'vitest';

import {
  attributeRunProcesses,
  capSelection,
  envSuffix,
  isOutsideAnyRun,
  parseScan,
  RUN_ID_ENV,
  RUN_OWNER_ENV,
  runOwnerOf,
  runTagEnv,
  runTagOf,
  type ScannedProcess,
} from './run-process-scan';

const RUN = '7c547591-dd9d-41ba-9ca9-c0f8c47c05cc';
const OTHER_RUN = '0b9e6a1f-2222-4c3d-8e8e-111111111111';
const OWNER = runOwnerOf('/Users/u/Library/Application Support/Geniro');
const OTHER_OWNER = runOwnerOf(
  '/Users/u/Library/Application Support/Geniro-dev',
);
const UID = 501;
const SELF = 900;

/** A row with defaults that would be selected if it carried the tag. */
function row(
  pid: number,
  ppid: number,
  args: string,
  overrides: Partial<ScannedProcess> = {},
): ScannedProcess {
  return {
    pid,
    ppid,
    uid: UID,
    tty: null,
    startedAt: 1_000,
    args,
    env: '',
    ...overrides,
  };
}

const tagged = (runId = RUN, owner = OWNER): string =>
  `HOME=/Users/u ${RUN_ID_ENV}=${runId} ${RUN_OWNER_ENV}=${owner}`;

/** The daemon, the Electron app above it, and launchd. */
const daemonChain: ScannedProcess[] = [
  row(1, 0, '/sbin/launchd', { uid: 0 }),
  row(800, 1, '/Users/u/geniro/Geniro', { env: null }),
  row(SELF, 800, 'node /Users/u/geniro/daemon/dist/main.js'),
];

const scope = { owner: OWNER, selfPid: SELF, uid: UID };

/** One run's owned set, capped — what the reaper starts from. */
function selectFor(
  rows: readonly ScannedProcess[],
  runId: string,
  cap?: number,
) {
  return capSelection(attributeRunProcesses(rows, scope).get(runId) ?? [], cap);
}

function select(rows: ScannedProcess[], runId = RUN) {
  return selectFor([...daemonChain, ...rows], runId);
}

const pidsOf = (selection: { targets: ScannedProcess[] }): number[] =>
  selection.targets.map((target) => target.pid).sort((a, b) => a - b);

describe('runOwnerOf', () => {
  it('names a profile by one space-free token, the same however the path is spelled', () => {
    expect(OWNER).toMatch(/^[0-9a-f]{16}$/);
    expect(runOwnerOf('/Users/u/Library/Application Support/Geniro/')).toBe(
      OWNER,
    );
    expect(OTHER_OWNER).not.toBe(OWNER);
  });

  it('stamps both halves of the tag', () => {
    expect(runTagEnv(RUN, OWNER)).toEqual({
      [RUN_ID_ENV]: RUN,
      [RUN_OWNER_ENV]: OWNER,
    });
  });
});

describe('parseScan', () => {
  it('joins each row with its terminal and the environment that follows its arguments', () => {
    const rows = parseScan(
      [
        '    1     0     0 ??       Mon Oct  5 17:34:22 2026     /sbin/launchd',
        '35073 35000   501 s003     Tue Oct 13 18:44:11 2026     node -e setTimeout(()=>{},2e4)',
      ].join('\n'),
      [
        '    1 /sbin/launchd',
        `35073 node -e setTimeout(()=>{},2e4) USER=u ${RUN_ID_ENV}=${RUN}`,
      ].join('\n'),
    );
    expect(rows).toEqual([
      {
        pid: 1,
        ppid: 0,
        uid: 0,
        tty: null,
        startedAt: Date.parse('Mon Oct 5 17:34:22 2026'),
        args: '/sbin/launchd',
        env: '',
      },
      {
        pid: 35073,
        ppid: 35000,
        uid: 501,
        tty: 's003',
        startedAt: Date.parse('Tue Oct 13 18:44:11 2026'),
        args: 'node -e setTimeout(()=>{},2e4)',
        env: `USER=u ${RUN_ID_ENV}=${RUN}`,
      },
    ]);
  });

  it('skips a line that does not open the way it was asked for', () => {
    expect(
      parseScan(
        ['  PID  PPID   UID TT STARTED COMMAND', 'ps: some warning'].join('\n'),
        '',
      ),
    ).toEqual([]);
  });

  it('leaves the environment unknown for a row the second listing does not have', () => {
    const [only] = parseScan(
      '  42     1   501 ??  Tue Oct 13 18:44:11 2026     node server.js',
      '',
    );
    expect(only?.env).toBeNull();
  });
});

describe('envSuffix', () => {
  it('never reads an argv that mentions the tag as carrying it', () => {
    // `grep GENIRO_RUN_ID=<id>`, or the shell line that ran it: the tag is in
    // the ARGUMENTS, and the environment after them is someone else's.
    const args = `grep ${RUN_ID_ENV}=${RUN}`;
    const env = envSuffix(
      args,
      `${args} HOME=/Users/u ${RUN_OWNER_ENV}=${OWNER}`,
    );
    expect(env).toBe(`HOME=/Users/u ${RUN_OWNER_ENV}=${OWNER}`);
    expect(runTagOf(env ?? '', OWNER)).toBeNull();
  });

  it('has no environment for a line that does not start with the arguments', () => {
    // The pid was recycled between the two listings.
    expect(envSuffix('node a.js', `vim notes ${RUN_ID_ENV}=${RUN}`)).toBeNull();
  });

  it('reads an environment the kernel withheld as empty', () => {
    expect(envSuffix('/bin/zsh -c x', '/bin/zsh -c x')).toBe('');
  });
});

describe('runTagOf', () => {
  it('reads the run only from this geniro’s own tag', () => {
    expect(runTagOf(tagged(), OWNER)).toBe(RUN);
    expect(runTagOf(tagged(RUN, OTHER_OWNER), OWNER)).toBeNull();
    expect(runTagOf(`HOME=/Users/u ${RUN_ID_ENV}=${RUN}`, OWNER)).toBeNull();
  });

  it('takes the id whole, never a prefix or a lookalike name', () => {
    expect(runTagOf(tagged(`${RUN}-x`), OWNER)).toBe(`${RUN}-x`);
    expect(
      runTagOf(`X${RUN_ID_ENV}=${RUN} ${RUN_OWNER_ENV}=${OWNER}`, OWNER),
    ).toBeNull();
    expect(runTagOf(tagged(''), OWNER)).toBeNull();
  });

  it('reads two different ids as no tag at all', () => {
    // One of them sits inside another variable's value — `npm_lifecycle_script`
    // holds a script's text — and a space-joined listing cannot say which.
    expect(
      runTagOf(
        `${tagged()} npm_lifecycle_script=x ${RUN_ID_ENV}=${OTHER_RUN}`,
        OWNER,
      ),
    ).toBeNull();
  });
});

describe('isOutsideAnyRun', () => {
  it.each([
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer',
    '/Users/u/Applications/WebStorm.app/Contents/MacOS/webstorm',
    '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
    '/usr/libexec/trustd',
    '/opt/homebrew/bin/colima start',
    '/opt/homebrew/bin/limactl hostagent --pidfile x colima',
    'ssh -F /Users/u/.colima/_lima/colima/ssh.config lima-colima',
    // The VM's port-forward master, with COLIMA_HOME moved elsewhere.
    'ssh: /Volumes/dev/colima/_lima/colima/ssh.sock [mux]',
  ])('is never a run’s: %s', (args) => {
    expect(isOutsideAnyRun(args)).toBe(true);
  });

  it.each([
    'next-server (v16.3.8)',
    'node /Users/u/app/node_modules/.bin/turbo run dev',
    // The browsers and dev builds an agent starts are exactly what is reaped.
    '/Users/u/Library/Caches/ms-playwright/chromium-1200/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    '/Users/u/geniro/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .',
    'docker compose up -d',
    '/opt/homebrew/bin/tmux new-session -d',
    // Anchored: a project folder named like a system one is the project's.
    '/Users/u/work/System/bin/server',
    // A word in the arguments names no program.
    '/Users/u/.local/bin/claude -p --append-system-prompt Use colima and /Applications/',
  ])('can be a run’s: %s', (args) => {
    expect(isOutsideAnyRun(args)).toBe(false);
  });
});

describe('attributeRunProcesses', () => {
  it('owns a tagged process and everything under it, tagged or not', () => {
    // pnpm and turbo carry the tag; turbo's strict env mode strips it from
    // the task it starts, so the dev server below is found by descent.
    const selection = select([
      row(10, 1, 'node /usr/local/bin/pnpm dev', { env: tagged() }),
      row(11, 10, 'node node_modules/.bin/turbo run dev', { env: tagged() }),
      row(12, 11, 'node /usr/local/bin/pnpm run dev', { env: 'PATH=/bin' }),
      row(13, 12, 'node next dev', { env: 'PATH=/bin' }),
      row(14, 13, 'next-server (v16.3.8)', { env: null }),
    ]);
    expect(pidsOf(selection)).toEqual([10, 11, 12, 13, 14]);
    expect(selection.overCap).toBeNull();
  });

  it('owns nothing of another run, or of another geniro', () => {
    const owned = attributeRunProcesses(
      [
        ...daemonChain,
        row(10, 1, 'node server.js', { env: tagged(OTHER_RUN) }),
        row(20, 1, 'node dev.js', { env: tagged(RUN, OTHER_OWNER) }),
        row(30, 1, 'node old.js', { env: `${RUN_ID_ENV}=${RUN}` }),
      ],
      scope,
    );
    expect(owned.get(RUN)).toBeUndefined();
    expect(owned.get(OTHER_RUN)?.map((p) => p.pid)).toEqual([10]);
  });

  it('puts each process in exactly one run — a tagged descendant in its own', () => {
    // Run A's agent started a shell that a run-B agent was later launched
    // from: B's tree is B's, not A's as well.
    const owned = attributeRunProcesses(
      [
        ...daemonChain,
        row(10, 1, 'node a.js', { env: tagged(RUN) }),
        row(11, 10, 'zsh'),
        row(12, 11, 'node b.js', { env: tagged(OTHER_RUN) }),
        row(13, 12, 'node b-child.js'),
      ],
      scope,
    );
    expect(owned.get(RUN)?.map((p) => p.pid)).toEqual([10, 11]);
    expect(owned.get(OTHER_RUN)?.map((p) => p.pid)).toEqual([12, 13]);
  });

  it('never owns the daemon or any ancestor of it, even tagged', () => {
    // An agent started this daemon (a dev build run from a thread): the whole
    // chain above it carries the tag.
    const rows: ScannedProcess[] = [
      row(1, 0, '/sbin/launchd', { uid: 0, env: tagged() }),
      row(800, 1, '/Users/u/geniro/Geniro', { env: tagged() }),
      row(SELF, 800, 'node daemon/dist/main.js', { env: tagged() }),
      row(30, SELF, 'claude -p', { env: tagged(OTHER_RUN) }),
      row(31, 30, 'node next dev', { env: 'PATH=/bin' }),
    ];
    // Nothing: the walk may not pass through the daemon to another run's CLI.
    expect(pidsOf(selectFor(rows, RUN))).toEqual([]);
  });

  it('owns nothing of a run the daemon itself belongs to', () => {
    // The app hosting this daemon was started from the run being reaped: its
    // renderer helpers are siblings of the daemon, not ancestors, and carry
    // the same tag — killing them takes the user's window down.
    const rows: ScannedProcess[] = [
      row(1, 0, '/sbin/launchd', { uid: 0 }),
      row(700, 1, 'node /usr/local/bin/pnpm dev', { env: tagged() }),
      row(800, 700, '/Users/u/geniro/node_modules/electron/Electron .', {
        env: tagged(),
      }),
      row(801, 800, '/Users/u/geniro/Electron Helper (Renderer)', {
        env: tagged(),
      }),
      row(SELF, 800, 'node daemon/dist/main.js', { env: tagged() }),
    ];
    expect(attributeRunProcesses(rows, scope).get(RUN)).toBeUndefined();
  });

  it('still owns a tagged child of the daemon and its tree, under an installed app', () => {
    // The installed Geniro lives in /Applications; its agents are the
    // daemon's children, and nothing about the app may fence them.
    const rows: ScannedProcess[] = [
      row(1, 0, '/sbin/launchd', { uid: 0 }),
      row(800, 1, '/Applications/Geniro.app/Contents/MacOS/Geniro'),
      row(SELF, 800, '/Applications/Geniro.app/Contents/MacOS/Geniro daemon'),
      row(30, SELF, 'claude -p', { env: tagged() }),
      row(31, 30, 'node mcp.js'),
      row(40, SELF, 'claude -p', { env: tagged(OTHER_RUN) }),
    ];
    expect(pidsOf(selectFor(rows, RUN))).toEqual([30, 31]);
  });

  it("never owns another user's process, nor anything below it", () => {
    const selection = select([
      row(10, 1, 'node server.js', { env: tagged() }),
      row(11, 10, 'sudo node privileged.js', { uid: 0, env: tagged() }),
      row(12, 11, 'node child-of-root.js', { env: tagged() }),
    ]);
    expect(pidsOf(selection)).toEqual([10]);
  });

  it('never owns pid 1, even when it reads as tagged', () => {
    expect(
      pidsOf(selectFor([row(1, 0, '/sbin/launchd', { env: tagged() })], RUN)),
    ).toEqual([]);
  });

  it.each([
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/System/Library/Frameworks/x',
    '/opt/homebrew/bin/colima start',
  ])(
    'never owns %s, tagged or as a descendant, nor what runs under it',
    (args) => {
      const selection = select([
        row(10, 1, args, { env: tagged() }),
        row(20, 1, 'node server.js', { env: tagged() }),
        row(21, 20, args, { env: 'PATH=/bin' }),
        row(22, 21, 'node below.js', { env: tagged() }),
      ]);
      expect(pidsOf(selection)).toEqual([20]);
    },
  );

  describe('what is on a terminal', () => {
    it('never owns a process on a terminal, nor what it runs', () => {
      const selection = select([
        row(10, 1, 'node watcher.js', { env: tagged(), tty: 's004' }),
        row(11, 10, 'node child.js', { env: tagged() }),
      ]);
      expect(selection.targets).toEqual([]);
    });

    it('still owns the agent above a command it runs on a terminal', () => {
      // codex runs a command on a pseudo-terminal when the model asks: the
      // command is left alone while its terminal lasts, the agent is not.
      const selection = select([
        row(30, SELF, 'codex app-server', { env: tagged() }),
        row(31, 30, '/bin/zsh -lc pnpm dev', { env: tagged(), tty: 's007' }),
        row(32, 30, 'node mcp.js'),
      ]);
      expect(pidsOf(selection)).toEqual([30, 32]);
    });

    it('owns a tmux an agent started, never the shells on its terminals', () => {
      const selection = select([
        row(50, 1, '/opt/homebrew/bin/tmux new-session -d', { env: tagged() }),
        row(51, 50, '-zsh', { env: tagged(), tty: 's005' }),
        row(52, 51, 'vim notes.md', { env: tagged(), tty: 's005' }),
        row(53, 50, 'node job.js', { env: tagged() }),
      ]);
      expect(pidsOf(selection)).toEqual([50, 53]);
    });

    it('fences only itself when the daemon runs something on a terminal', () => {
      // A CLI sign-in runs under `script` beside the agents: they stay owned.
      const selection = select([
        row(61, SELF, '/usr/bin/script -q /dev/null claude login', {
          tty: 's009',
        }),
        row(30, SELF, 'claude -p', { env: tagged() }),
      ]);
      expect(pidsOf(selection)).toEqual([30]);
    });
  });

  it('owns nothing over the cap, and all of a tree right at it', () => {
    const rows = [
      row(10, 1, 'node root.js', { env: tagged() }),
      ...Array.from({ length: 5 }, (_, i) => row(100 + i, 10, 'node w.js')),
    ];
    const over = selectFor([...daemonChain, ...rows], RUN, 5);
    expect(over.targets).toEqual([]);
    expect(over.overCap?.count).toBe(6);
    expect(
      selectFor([...daemonChain, ...rows.slice(0, 5)], RUN, 5).targets,
    ).toHaveLength(5);
  });

  it('ends on a process listed as its own parent', () => {
    expect(
      pidsOf(select([row(10, 10, 'node a.js', { env: tagged() })])),
    ).toEqual([10]);
  });

  it('ends on a parent loop above the daemon', () => {
    const rows = [
      row(800, SELF, 'node app.js'),
      row(SELF, 800, 'node daemon.js'),
      row(10, 1, 'node a.js', { env: tagged() }),
    ];
    expect(pidsOf(selectFor(rows, RUN))).toEqual([10]);
  });

  it('ends on a loop between processes on a terminal', () => {
    const rows = [
      ...daemonChain,
      row(70, 71, 'zsh', { tty: 's001' }),
      row(71, 70, 'zsh', { tty: 's001' }),
      row(10, 1, 'node a.js', { env: tagged() }),
    ];
    expect(pidsOf(selectFor(rows, RUN))).toEqual([10]);
  });
});
