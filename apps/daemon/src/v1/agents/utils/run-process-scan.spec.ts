import { describe, expect, it } from 'vitest';

import {
  carriesRunTag,
  envSuffix,
  isProtectedProcess,
  parseScan,
  RUN_ID_ENV,
  type ScannedProcess,
  selectRunProcesses,
} from './run-process-scan';

const RUN = '7c547591-dd9d-41ba-9ca9-c0f8c47c05cc';
const OTHER_RUN = '0b9e6a1f-2222-4c3d-8e8e-111111111111';
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
    startedAt: 1_000,
    args,
    env: '',
    ...overrides,
  };
}

const tagged = (runId = RUN): string => `HOME=/Users/u ${RUN_ID_ENV}=${runId}`;

/** The daemon, the Electron app above it, and launchd. */
const daemonChain: ScannedProcess[] = [
  row(1, 0, '/sbin/launchd', { uid: 0 }),
  row(800, 1, '/Users/u/geniro/Geniro', { env: null }),
  row(SELF, 800, 'node /Users/u/geniro/daemon/dist/main.js'),
];

function select(rows: ScannedProcess[], runId = RUN) {
  return selectRunProcesses([...daemonChain, ...rows], {
    runId,
    selfPid: SELF,
    uid: UID,
  });
}

const pidsOf = (selection: { targets: ScannedProcess[] }): number[] =>
  selection.targets.map((target) => target.pid).sort((a, b) => a - b);

describe('parseScan', () => {
  it('joins each row with the environment that follows its arguments', () => {
    const rows = parseScan(
      [
        '    1     0     0 Mon Oct  5 17:34:22 2026     /sbin/launchd',
        '35073 35000   501 Tue Oct 13 18:44:11 2026     node -e setTimeout(()=>{},2e4)',
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
        startedAt: Date.parse('Mon Oct 5 17:34:22 2026'),
        args: '/sbin/launchd',
        env: '',
      },
      {
        pid: 35073,
        ppid: 35000,
        uid: 501,
        startedAt: Date.parse('Tue Oct 13 18:44:11 2026'),
        args: 'node -e setTimeout(()=>{},2e4)',
        env: `USER=u ${RUN_ID_ENV}=${RUN}`,
      },
    ]);
  });

  it('skips a line that does not open the way it was asked for', () => {
    expect(
      parseScan(
        ['  PID  PPID   UID STARTED COMMAND', 'ps: some warning'].join('\n'),
        '',
      ),
    ).toEqual([]);
  });

  it('leaves the environment unknown for a row the second listing does not have', () => {
    const [only] = parseScan(
      '  42     1   501 Tue Oct 13 18:44:11 2026     node server.js',
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
    const env = envSuffix(args, `${args} HOME=/Users/u`);
    expect(env).toBe('HOME=/Users/u');
    expect(carriesRunTag(env ?? '', RUN)).toBe(false);
  });

  it('has no environment for a line that does not start with the arguments', () => {
    // The pid was recycled between the two listings.
    expect(envSuffix('node a.js', `vim notes ${RUN_ID_ENV}=${RUN}`)).toBeNull();
  });

  it('reads an environment the kernel withheld as empty', () => {
    expect(envSuffix('/bin/zsh -c x', '/bin/zsh -c x')).toBe('');
  });
});

describe('carriesRunTag', () => {
  it('matches only the exact run id', () => {
    expect(carriesRunTag(tagged(), RUN)).toBe(true);
    expect(carriesRunTag(tagged(OTHER_RUN), RUN)).toBe(false);
    expect(carriesRunTag(tagged(`${RUN}-x`), RUN)).toBe(false);
    expect(carriesRunTag(tagged(RUN.slice(0, 8)), RUN)).toBe(false);
    expect(carriesRunTag(`X${RUN_ID_ENV}=${RUN}`, RUN)).toBe(false);
  });
});

describe('isProtectedProcess', () => {
  it.each([
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer',
    '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
    '/usr/libexec/trustd',
    '/opt/homebrew/bin/colima start',
    '/opt/homebrew/bin/limactl hostagent --pidfile x colima',
    '/opt/homebrew/bin/qemu-system-aarch64 -M virt',
    'docker compose up -d',
    '/usr/local/bin/com.docker.backend',
    'ssh -F /Users/u/.colima/_lima/colima/ssh.config lima-colima',
  ])('protects %s', (args) => {
    expect(isProtectedProcess(args)).toBe(true);
  });

  it.each([
    'next-server (v16.3.8)',
    'node /Users/u/app/node_modules/.bin/turbo run dev',
    '/Users/u/Library/Caches/ms-playwright/chromium-1200/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'node /Users/u/climate/server.js',
  ])('does not protect %s', (args) => {
    expect(isProtectedProcess(args)).toBe(false);
  });
});

describe('selectRunProcesses', () => {
  it('selects a tagged process and everything under it, tagged or not', () => {
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

  it('selects nothing for another run', () => {
    const selection = select([
      row(10, 1, 'node server.js', { env: tagged(OTHER_RUN) }),
      row(11, 10, 'node worker.js'),
    ]);
    expect(selection.targets).toEqual([]);
  });

  it.each(['', '   '])('selects nothing for the empty run id %j', (runId) => {
    // A process whose tag is EMPTY is the one an empty id would match.
    const selection = select(
      [
        row(10, 1, 'node a.js', { env: `${RUN_ID_ENV}=` }),
        row(11, 1, 'node b.js', { env: `${RUN_ID_ENV}=${runId}` }),
      ],
      runId,
    );
    expect(selection.targets).toEqual([]);
  });

  it('never selects the daemon or any ancestor of it, even tagged', () => {
    // An agent started this daemon (a dev build run from a thread): the whole
    // chain above it carries the tag.
    const rows: ScannedProcess[] = [
      row(1, 0, '/sbin/launchd', { uid: 0, env: tagged() }),
      row(800, 1, '/Users/u/geniro/Geniro', { env: tagged() }),
      row(SELF, 800, 'node daemon/dist/main.js', { env: tagged() }),
      row(30, SELF, 'claude -p', { env: tagged(OTHER_RUN) }),
      row(31, 30, 'node next dev', { env: 'PATH=/bin' }),
    ];
    const selection = selectRunProcesses(rows, {
      runId: RUN,
      selfPid: SELF,
      uid: UID,
    });
    // Nothing: the walk may not pass through the daemon to another run's CLI.
    expect(selection.targets).toEqual([]);
  });

  it('still reaches a tagged child of the daemon and its tree', () => {
    const selection = select([
      row(30, SELF, 'claude -p', { env: tagged() }),
      row(31, 30, '/bin/zsh -c nohup pnpm dev', { env: '' }),
      row(32, 31, 'node /usr/local/bin/pnpm dev', { env: tagged() }),
      row(40, SELF, 'claude -p', { env: tagged(OTHER_RUN) }),
    ]);
    expect(pidsOf(selection)).toEqual([30, 31, 32]);
  });

  it("skips another user's process and does not walk below it", () => {
    const selection = select([
      row(10, 1, 'node server.js', { env: tagged() }),
      row(11, 10, 'sudo node privileged.js', { uid: 0, env: tagged() }),
      row(12, 11, 'node child-of-root.js'),
    ]);
    expect(pidsOf(selection)).toEqual([10]);
  });

  it('skips pid 1 even when it reads as tagged', () => {
    const selection = selectRunProcesses(
      [row(1, 0, '/sbin/launchd', { env: tagged() })],
      { runId: RUN, selfPid: SELF, uid: UID },
    );
    expect(selection.targets).toEqual([]);
  });

  it.each([
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/System/Library/Frameworks/x',
    '/usr/libexec/xpcproxy',
    '/opt/homebrew/bin/colima start',
    '/opt/homebrew/bin/limactl hostagent',
    '/opt/homebrew/bin/qemu-system-aarch64',
    '/usr/local/bin/docker compose up',
  ])('never selects %s, tagged or as a descendant', (args) => {
    const selection = select([
      row(10, 1, args, { env: tagged() }),
      row(20, 1, 'node server.js', { env: tagged() }),
      row(21, 20, args, { env: 'PATH=/bin' }),
      row(22, 21, 'node below-protected.js'),
    ]);
    expect(pidsOf(selection)).toEqual([20]);
  });

  it('selects nothing at all when the match is over the cap', () => {
    const rows = [
      row(10, 1, 'node root.js', { env: tagged() }),
      ...Array.from({ length: 5 }, (_, i) => row(100 + i, 10, 'node w.js')),
    ];
    const selection = selectRunProcesses([...daemonChain, ...rows], {
      runId: RUN,
      selfPid: SELF,
      uid: UID,
      cap: 5,
    });
    expect(selection.targets).toEqual([]);
    expect(selection.overCap?.count).toBe(6);
  });

  it('selects a tree right at the cap', () => {
    const rows = [
      row(10, 1, 'node root.js', { env: tagged() }),
      ...Array.from({ length: 4 }, (_, i) => row(100 + i, 10, 'node w.js')),
    ];
    const selection = selectRunProcesses([...daemonChain, ...rows], {
      runId: RUN,
      selfPid: SELF,
      uid: UID,
      cap: 5,
    });
    expect(selection.targets).toHaveLength(5);
  });
});
