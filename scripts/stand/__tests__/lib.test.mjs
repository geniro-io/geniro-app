import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  KILL_CAP,
  callerProcesses,
  buildKillList,
  checkWorktreeFacts,
  descendantsOf,
  isRealProfile,
  parseLsofCwd,
  parsePsTable,
  parseSlot,
  parseViteUrl,
  pickSlot,
  isStandAlive,
  protectedReason,
  resolveWorktree,
  splitSeedList,
  sameProcess,
  slotPorts,
  worktreeKey,
} from '../lib.mjs';

const HOME = '/Users/dev';
const WT = '/Users/dev/Library/Application Support/Geniro/worktrees/0b22';

describe('slots', () => {
  it('maps a slot to its daemon and CDP ports', () => {
    assert.deepEqual(slotPorts(0), { daemon: 47625, cdp: 9333 });
    assert.deepEqual(slotPorts(3), { daemon: 47655, cdp: 9363 });
  });

  it('picks the lowest slot where neither port listens', () => {
    const busy = new Set([47625, 9343]);
    assert.equal(
      pickSlot((port) => busy.has(port)),
      2,
    );
  });

  it('answers null when every slot is taken', () => {
    assert.equal(
      pickSlot(() => true),
      null,
    );
  });

  it('accepts slots 0-9 only', () => {
    assert.equal(parseSlot(undefined), undefined);
    assert.equal(parseSlot('9'), 9);
    assert.throws(() => parseSlot('10'), /0-9/);
    assert.throws(() => parseSlot('1.5'), /0-9/);
  });
});

describe('profiles', () => {
  it('recognises the installed app profile and its children', () => {
    assert.equal(
      isRealProfile(`${HOME}/Library/Application Support/Geniro`, HOME),
      true,
    );
    assert.equal(isRealProfile(`${HOME}/.geniro/sub`, HOME), true);
  });

  it('does not mistake a sibling folder for the real profile', () => {
    assert.equal(
      isRealProfile(`${HOME}/Library/Application Support/Geniro-dev`, HOME),
      false,
    );
    assert.equal(
      isRealProfile('/var/folders/x/T/geniro-stands/a-slot0', HOME),
      false,
    );
  });

  it('keys a worktree by a safe name and a hash of its full path', () => {
    const key = worktreeKey(WT);
    assert.match(key, /^0b22-[0-9a-f]{8}$/);
    assert.notEqual(worktreeKey('/a/0b22'), key);
  });
});

describe('worktree guard', () => {
  const linked = {
    home: HOME,
    toplevel: WT,
    gitDir: '/repo/.git/worktrees/0b22',
    commonDir: '/repo/.git',
  };

  it('accepts a linked worktree whose path has spaces', () => {
    assert.equal(checkWorktreeFacts({ path: WT, ...linked }), null);
  });

  it('refuses an empty or relative path', () => {
    assert.match(checkWorktreeFacts({ path: '', ...linked }), /absolute/);
    assert.match(
      checkWorktreeFacts({ path: 'apps/ui', ...linked }),
      /absolute/,
    );
  });

  it('refuses the root and the home folder', () => {
    assert.match(
      checkWorktreeFacts({ path: '/', ...linked }),
      /not a worktree/,
    );
    assert.match(
      checkWorktreeFacts({ path: HOME, ...linked }),
      /not a worktree/,
    );
  });

  it('refuses a folder below a worktree root', () => {
    assert.match(
      checkWorktreeFacts({ path: `${WT}/apps`, ...linked }),
      /not a worktree root/,
    );
  });

  it('refuses the main checkout', () => {
    assert.match(
      checkWorktreeFacts({
        path: '/repo',
        home: HOME,
        toplevel: '/repo',
        gitDir: '.git',
        commonDir: '.git',
      }),
      /main checkout/,
    );
  });

  it('refuses a folder outside git', () => {
    assert.match(
      checkWorktreeFacts({ path: '/tmp/x', home: HOME, toplevel: null }),
      /not inside a git checkout/,
    );
  });
});

describe('log and process parsing', () => {
  it('reads the vite URL through colour codes', () => {
    const log =
      '\u001b[32m  ➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5174\u001b[22m/\u001b[39m\n';
    assert.equal(parseViteUrl(log), 'http://localhost:5174/');
    assert.equal(parseViteUrl('building...'), null);
  });

  it('keeps only cwd entries inside the worktree, deleted ones included', () => {
    const text = [
      'p10',
      `n${WT}`,
      'p11',
      `n${WT}/apps/ui`,
      'p12',
      `n${WT}-other`,
      'p13',
      `n${WT}/apps (deleted)`,
      'p14',
      'n/',
    ].join('\n');
    assert.deepEqual(parseLsofCwd(text, WT), [10, 11, 13]);
  });

  it('parses ps rows whose command holds spaces', () => {
    const table = parsePsTable(
      `  101     1   101   501 Sat Nov 28 15:56:01 2026 /a b/Electron Helper (Renderer) --type=renderer\n`,
    );
    assert.deepEqual(table.get(101), {
      pid: 101,
      ppid: 1,
      pgid: 101,
      uid: 501,
      started: 'Sat Nov 28 15:56:01 2026',
      command: '/a b/Electron Helper (Renderer) --type=renderer',
    });
  });
});

const proc = (pid, ppid, command, uid = 501, pgid = pid) => [
  pid,
  { pid, ppid, pgid, uid, started: 'Sat Nov 28 10:00:00 2026', command },
];

describe('kill list', () => {
  const table = new Map([
    proc(1, 0, '/sbin/launchd', 0),
    proc(50, 1, '/bin/zsh'),
    proc(60, 50, '/Users/dev/.local/bin/claude --print'),
    proc(61, 60, '/bin/zsh -c node stop.mjs'),
    proc(62, 61, 'node stop.mjs', 501, 62),
    proc(63, 61, 'tail -5', 501, 62),
    proc(64, 62, 'ps -axww', 0, 62),
    proc(
      100,
      1,
      `node ${WT}/node_modules/electron-vite/bin/electron-vite.js dev`,
    ),
    proc(
      101,
      100,
      `${WT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .`,
    ),
    proc(
      102,
      101,
      `${WT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ${WT}/apps/daemon/dist/main.js`,
    ),
    proc(103, 102, 'claude -p --model haiku'),
    proc(104, 102, '/bin/sh -c sleep 600'),
    proc(200, 1, '/Applications/Geniro.app/Contents/MacOS/Geniro'),
    proc(300, 1, '/usr/sbin/cron', 0),
  ]);
  const keep = callerProcesses(table, 62);

  it('walks descendants of every root', () => {
    assert.deepEqual(
      [...descendantsOf(table, [100])].sort((a, b) => a - b),
      [100, 101, 102, 103, 104],
    );
  });

  it('signals the stand tree and keeps the caller, agent CLIs and other users', () => {
    const { kill, kept, overCap } = buildKillList(table, [50, 100, 300], {
      uid: 501,
      keep,
    });
    assert.deepEqual(
      kill.map((p) => p.pid),
      [100, 101, 102, 104],
    );
    assert.deepEqual(
      kept.map((p) => [p.pid, p.reason]),
      [
        [50, 'the caller: this script, its pipeline or an ancestor'],
        [103, 'agent CLI, Geniro.app or container runtime'],
        [300, 'owned by another user'],
      ],
    );
    assert.equal(overCap, false);
  });

  it('keeps everything under an agent CLI, found by cwd or not', () => {
    const agent = new Map([
      ...table,
      proc(400, 1, '/Users/dev/.local/share/claude/versions/2.1.331 --resume'),
      proc(401, 400, '/bin/zsh -c pnpm dev'),
      proc(402, 401, 'node vite'),
      proc(403, 400, 'node mcp-server.js'),
    ]);
    const { kill, kept } = buildKillList(agent, [400, 401, 403], {
      uid: 501,
      keep: new Set(),
    });
    assert.deepEqual(kill, []);
    assert.deepEqual(
      kept.map((p) => p.pid),
      [400, 401, 403],
    );
    assert.match(kept[1].reason, /under a protected process \(400/);
  });

  it('follows roots the caller spawned itself even under its own agent', () => {
    const own = new Map([
      ...table,
      proc(70, 62, 'node electron-vite.js dev', 501, 70),
      proc(71, 70, 'Electron .', 501, 70),
    ]);
    const options = { uid: 501, keep: callerProcesses(own, 62) };
    assert.deepEqual(
      buildKillList(own, [70], { ...options, trustRoots: true }).kill.map(
        (p) => p.pid,
      ),
      [70, 71],
    );
    assert.deepEqual(buildKillList(own, [70], options).kill, []);
  });

  it('never lists an installed application', () => {
    const { kill, kept } = buildKillList(table, [200], {
      uid: 501,
      keep: new Set(),
    });
    assert.deepEqual(kill, []);
    assert.equal(kept[0].reason, 'system or installed application');
  });

  it('flags a list over the cap', () => {
    const big = new Map([proc(1000, 1, 'node root')]);
    for (let pid = 1001; pid <= 1000 + KILL_CAP; pid++) {
      big.set(pid, {
        pid,
        ppid: 1000,
        uid: 501,
        started: 'x',
        command: 'node child',
      });
    }
    assert.equal(
      buildKillList(big, [1000], { uid: 501, keep: new Set() }).overCap,
      true,
    );
  });

  it('treats a reused pid as another process', () => {
    const [, recorded] = proc(101, 100, 'Electron');
    const reused = new Map([
      [101, { ...recorded, started: 'Sat Nov 28 11:00:00 2026' }],
    ]);
    assert.equal(sameProcess(reused, recorded), false);
    assert.equal(sameProcess(new Map([[101, recorded]]), recorded), true);
  });
});

describe('stand records', () => {
  const record = { worktree: WT, pids: { parent: 100 } };

  it('reads a stand as alive while its parent runs electron-vite from its worktree', () => {
    const table = new Map([
      proc(
        100,
        1,
        `node ${WT}/node_modules/electron-vite/bin/electron-vite.js dev`,
      ),
    ]);
    assert.equal(isStandAlive(record, table), true);
  });

  it('reads a reused pid or a gone parent as dead', () => {
    assert.equal(
      isStandAlive(record, new Map([proc(100, 1, 'node other.js')])),
      false,
    );
    assert.equal(
      isStandAlive(
        record,
        new Map([
          proc(
            100,
            1,
            'node /other/node_modules/electron-vite/bin/electron-vite.js dev',
          ),
        ]),
      ),
      false,
    );
    assert.equal(isStandAlive(record, new Map()), false);
  });
});

describe('seed list', () => {
  it('splits rows the seeder writes from the live scenario boot starts', () => {
    assert.deepEqual(splitSeedList(undefined), { rows: '', live: false });
    assert.deepEqual(splitSeedList('fixtures'), { rows: '', live: false });
    assert.deepEqual(splitSeedList(' working-threads , long-transcript '), {
      rows: 'long-transcript',
      live: true,
    });
    assert.deepEqual(splitSeedList('all'), { rows: 'all', live: true });
  });
});

describe('resolveWorktree on a real repository', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stand lib ')));
  const main = join(root, 'main checkout');
  const linked = join(root, 'linked worktree');
  const git = (cwd, ...args) =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  execFileSync('git', ['init', '-q', main]);
  git(
    main,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
  git(main, 'worktree', 'add', '-q', '--detach', linked);
  after(() => rmSync(root, { recursive: true, force: true }));

  it('accepts a linked worktree whose path has spaces', () => {
    assert.equal(resolveWorktree(linked), linked);
  });

  it('refuses the main checkout and a folder inside the worktree', () => {
    assert.throws(() => resolveWorktree(main), /main checkout/);
    git(linked, 'status');
    assert.throws(() => resolveWorktree(join(linked, '.git')), /not/);
  });
});
