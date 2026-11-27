import { describe, expect, it } from 'vitest';

import {
  commandLiveness,
  commandNeedles,
  commandTargets,
  descendantsOf,
  endedRecordOf,
  isCommandRunning,
  parseProcessRows,
  type ProcessRow,
  recordedPidsRunning,
} from './process-descendants';

describe('endedRecordOf', () => {
  it('takes the newest ended record of the command, its whitespace aside', () => {
    const records = [
      {
        pid: 1,
        command: 'make  test',
        running: false,
        exitCode: 1,
        endedAt: '2026-11-13T08:00:00.000Z',
      },
      {
        pid: 2,
        command: 'make test',
        running: false,
        exitCode: 0,
        endedAt: '2026-11-13T09:00:00.000Z',
      },
      { pid: 3, command: 'make test', running: true },
      { pid: 4, command: 'make build', running: false, exitCode: 2 },
    ];

    const start = Date.parse('2026-11-13T07:00:00.000Z');
    expect(endedRecordOf(records, 'make\ntest', start)?.pid).toBe(2);
    expect(endedRecordOf(records, 'make lint', start)).toBeNull();
    expect(
      endedRecordOf([{ pid: 9, command: 'x y', running: true }], 'x y', start),
    ).toBeNull();
  });

  it('takes no record that ended before the call was made — an earlier run of the same line', () => {
    const records = [
      {
        pid: 1,
        command: 'make test',
        running: false,
        exitCode: 1,
        endedAt: '2026-11-13T08:00:00.000Z',
      },
      { pid: 4, command: 'make test', running: false, exitCode: 2 },
    ];

    expect(
      endedRecordOf(
        records,
        'make test',
        Date.parse('2026-11-13T08:30:00.000Z'),
      ),
    ).toBeNull();
  });
});

describe('parseProcessRows', () => {
  it('reads the three columns `ps` is asked for', () => {
    expect(
      parseProcessRows(
        ['    1     0 /sbin/launchd', ' 9452  9446 sleep 300', ''].join('\n'),
      ),
    ).toEqual([
      { pid: 1, ppid: 0, args: '/sbin/launchd' },
      { pid: 9452, ppid: 9446, args: 'sleep 300' },
    ]);
  });

  it('keeps a command with spaces whole', () => {
    // The column is LAST for this reason, and the split has to stop after two
    // integers: a command is routinely a whole shell line, and cutting it at
    // the next space is how the thing being looked for stops being findable.
    const rows = parseProcessRows(
      ' 100 99 /bin/zsh -c builtin eval "$1" -- pnpm run dev --filter web',
    );
    expect(rows[0]?.args).toBe(
      '/bin/zsh -c builtin eval "$1" -- pnpm run dev --filter web',
    );
  });

  it('reads back the non-ASCII text `ps` escapes under the C locale', () => {
    // `ps` prints an em dash and Cyrillic as vis(3) escapes; the agent's
    // command it is matched against carries the characters themselves.
    const [only] = parseProcessRows(
      '  42     1 perl -e sleep 4 fixM-bM^@M^TM-QM^BM-PM-5M-QM^AM-QM^B',
    );
    expect(only?.args).toBe('perl -e sleep 4 fix—тест');
  });

  it('skips a line that does not open with two integers', () => {
    // Another program's output: a header, a warning, a blank. Read as a row it
    // would arrive as pid 0 and reparent half the machine under the tree.
    expect(
      parseProcessRows(
        ['  PID  PPID COMMAND', 'ps: some warning', ' 7 1 /usr/bin/true'].join(
          '\n',
        ),
      ),
    ).toEqual([{ pid: 7, ppid: 1, args: '/usr/bin/true' }]);
  });
});

describe('descendantsOf', () => {
  const rows: ProcessRow[] = [
    { pid: 1, ppid: 0, args: 'launchd' },
    { pid: 100, ppid: 1, args: 'daemon' },
    { pid: 200, ppid: 100, args: 'cursor-agent acp' },
    { pid: 300, ppid: 200, args: '/bin/zsh -c … -- sleep 300' },
    { pid: 400, ppid: 300, args: 'sleep 300' },
    { pid: 500, ppid: 1, args: 'somebody else' },
  ];

  it('reaches a command nested two levels under the agent', () => {
    // Depth is the whole reason this walks instead of filtering on `ppid`:
    // measured on cursor-agent, the command runs under a shell wrapper, so it
    // is a GRANDCHILD of the process geniro spawned.
    expect(descendantsOf(rows, 200).map((r) => r.pid)).toEqual([300, 400]);
  });

  it('excludes the root and everything outside its tree', () => {
    expect(descendantsOf(rows, 200).some((r) => r.pid === 200)).toBe(false);
    expect(descendantsOf(rows, 200).some((r) => r.pid === 500)).toBe(false);
  });

  it('terminates on a table that contains a cycle', () => {
    // `ps` takes no atomic snapshot, so a process exiting mid-listing can leave
    // a row whose parent has already been reparented. Rare, and a hang here
    // would be inside a turn's settle.
    const cyclic: ProcessRow[] = [
      { pid: 10, ppid: 11, args: 'a' },
      { pid: 11, ppid: 10, args: 'b' },
    ];
    expect(descendantsOf(cyclic, 10).map((r) => r.pid)).toEqual([11]);
  });
});

describe('isCommandRunning', () => {
  const wrapped: ProcessRow[] = [
    {
      pid: 300,
      ppid: 200,
      args: '/bin/zsh -c builtin export PATH=…; builtin eval "$1" -- sleep 300',
    },
  ];

  it('finds a command inside the shell wrapper its CLI ran it through', () => {
    // The measured shape: cursor wraps what it runs in a ~400-character zsh
    // preamble ending `-- <command>`, so an equality against the agent's own
    // string matches nothing.
    expect(isCommandRunning(wrapped, 'sleep 300')).toBe(true);
  });

  it('says no when nothing is running it', () => {
    expect(isCommandRunning(wrapped, 'pnpm run dev')).toBe(false);
    expect(isCommandRunning([], 'sleep 300')).toBe(false);
  });

  it('matches a multi-line command against the one line `ps` reports', () => {
    // An agent's shell command routinely spans lines; the process table has
    // none. Comparing them unnormalized never matches, which would silently
    // turn the whole feature off for exactly the long-running commands it is
    // for.
    const rows: ProcessRow[] = [
      { pid: 1, ppid: 0, args: 'bash -c export A=1 && pnpm run dev' },
    ];
    expect(isCommandRunning(rows, 'export A=1 &&\n  pnpm run dev')).toBe(true);
  });

  it('refuses an empty command rather than matching everything', () => {
    expect(isCommandRunning(wrapped, '   ')).toBe(false);
  });
});

describe('commandNeedles', () => {
  it("reaches what a shell leaves running once it and `env` have exec'd away", () => {
    // The reported command, verbatim. Measured: a second after launch the table
    // holds no `zsh`, no `env` and no redirection — only what `env` exec'd —
    // so the written text alone matches nothing at all.
    const needles = commandNeedles(
      "/bin/zsh -lc 'env -u ELECTRON_RUN_AS_NODE GENIRO_UI_USER_DATA=/tmp/review pnpm dev -- --remoteDebuggingPort 9341 > /tmp/dev.log 2>&1'",
    );

    expect(needles[0]).toBe(
      "/bin/zsh -lc 'env -u ELECTRON_RUN_AS_NODE GENIRO_UI_USER_DATA=/tmp/review pnpm dev -- --remoteDebuggingPort 9341 > /tmp/dev.log 2>&1'",
    );
    expect(needles).toContain('pnpm dev -- --remoteDebuggingPort 9341');
    const exec: ProcessRow[] = [
      {
        pid: 7,
        ppid: 1,
        args: 'node /opt/homebrew/bin/pnpm dev -- --remoteDebuggingPort 9341',
      },
    ];
    expect(isCommandRunning(exec, needles[0] ?? '')).toBe(false);
    expect(needles.some((needle) => isCommandRunning(exec, needle))).toBe(true);
  });

  it("reaches what `nohup` exec'd, which the table lists without it", () => {
    const needles = commandNeedles(
      'nohup python3 -m http.server 8765 > /tmp/p.log 2>&1 & echo $!',
    );
    expect(needles).toContain('python3 -m http.server 8765');
    expect(
      needles.some((needle) =>
        isCommandRunning(
          [{ pid: 7, ppid: 1, args: 'python3 -m http.server 8765' }],
          needle,
        ),
      ),
    ).toBe(true);
  });

  it('splits a chain and drops the builtins that leave no process', () => {
    expect(commandNeedles('cd apps/ui && PORT=3000 pnpm start')).toEqual([
      'cd apps/ui && PORT=3000 pnpm start',
      'pnpm start',
    ]);
  });

  it('reads each line of a script as a command, and a heredoc’s body as none', () => {
    expect(
      commandNeedles(
        "cd app\npnpm install\npython3 - <<'PY'\nprint(1)\nPY\npnpm dev",
      ),
    ).toEqual([
      "cd app pnpm install python3 - <<'PY' print(1) PY pnpm dev",
      'pnpm install',
      'pnpm dev',
    ]);
  });

  it('cuts a trailing comment, never a # inside quotes or a word', () => {
    expect(commandNeedles('grep -r "#todo" src # find todos')).toEqual([
      'grep -r "#todo" src # find todos',
      'grep -r "#todo" src',
    ]);
    expect(commandNeedles('curl http://host/#top')).toEqual([
      'curl http://host/#top',
    ]);
  });

  it('keeps nothing too short to be specific', () => {
    expect(commandNeedles('ls')).toEqual([]);
  });
});

describe('commandTargets', () => {
  // The shapes measured under claude's Bash tool: the command is eval'd from a
  // single-quoted string, each quote of it written as '"'"', and the program
  // it execs shows its argv with no quotes at all.
  const claudeShell = (command: string): string =>
    `/bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval '${command.replace(/'/g, `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-1-cwd`;

  it('finds a command that holds quotes, through the shell claude evals it in', () => {
    const tree: ProcessRow[] = [
      { pid: 200, ppid: 100, args: claudeShell("perl -e 'sleep 327'") },
      { pid: 201, ppid: 200, args: 'perl -e sleep 327' },
    ];

    expect(commandTargets(tree, "perl -e 'sleep 327'")).toEqual([200]);
  });

  it('finds a command with escaped double quotes once its shell has gone', () => {
    const tree: ProcessRow[] = [
      { pid: 201, ppid: 1, args: 'perl -e print "hi"; sleep 99' },
    ];

    expect(commandTargets(tree, 'perl -e "print \\"hi\\"; sleep 99"')).toEqual([
      201,
    ]);
  });

  it('finds a quoted command a shell was handed whole, once that shell has exec’d it', () => {
    const tree: ProcessRow[] = [
      { pid: 201, ppid: 100, args: 'perl -e sleep 300' },
    ];

    expect(commandTargets(tree, `/bin/zsh -lc "perl -e 'sleep 300'"`)).toEqual([
      201,
    ]);
  });

  it('takes only what the text as written matches when it matches anything', () => {
    const tree: ProcessRow[] = [
      { pid: 300, ppid: 100, args: "/bin/sh -c perl -e 'x y z'" },
      { pid: 400, ppid: 100, args: 'perl -e x y z' },
    ];

    expect(commandTargets(tree, "perl -e 'x y z'")).toEqual([300]);
  });

  it('finds the last line of a script a shell has exec’d in its place', () => {
    const tree: ProcessRow[] = [
      { pid: 201, ppid: 100, args: 'node server.js --port 4000' },
    ];

    expect(
      commandTargets(tree, "/bin/zsh -lc 'cd app\nnode server.js --port 4000'"),
    ).toEqual([201]);
    expect(
      commandTargets(tree, 'cd app\nnode server.js \\\n  --port 4000'),
    ).toEqual([201]);
  });

  it('finds a command written with a trailing comment, which the table never shows', () => {
    const tree: ProcessRow[] = [
      { pid: 201, ppid: 100, args: 'node server.js --port 4000' },
    ];

    expect(
      commandTargets(tree, 'node server.js --port 4000 # the dev server'),
    ).toEqual([201]);
  });

  it('never takes a single command of a script through a process another running command matches', () => {
    const tree: ProcessRow[] = [
      { pid: 300, ppid: 100, args: '/bin/sh -c pnpm dev' },
      { pid: 301, ppid: 300, args: 'node /opt/pnpm dev' },
    ];

    expect(commandTargets(tree, 'cd web\npnpm dev')).toEqual([300]);
    expect(commandTargets(tree, 'cd web\npnpm dev', ['pnpm dev'])).toEqual([]);
    expect(commandTargets(tree, 'pnpm dev', ['cd web\npnpm dev'])).toEqual([
      300,
    ]);
  });

  it('never reads a heredoc as the bare program it feeds, which another command may run too', () => {
    const tree: ProcessRow[] = [
      { pid: 400, ppid: 100, args: 'perl -e sleep 9' },
    ];

    expect(commandTargets(tree, "perl - <<'PL'\nprint 1\nPL")).toEqual([]);
  });

  it('matches nothing for a command that is only quoting, or that nothing runs', () => {
    const tree: ProcessRow[] = [
      { pid: 300, ppid: 100, args: claudeShell('tail -f /dev/zero') },
      { pid: 301, ppid: 300, args: 'tail -f /dev/zero' },
    ];

    expect(commandTargets(tree, "''")).toEqual([]);
    expect(commandTargets(tree, '"\\"\\""')).toEqual([]);
    expect(commandTargets(tree, "grep -r 'nothing here'")).toEqual([]);
  });
});

describe('commandLiveness', () => {
  const heredoc = "python3 << 'PY'\nimport time\nPY";
  const wrapper: ProcessRow = {
    pid: 500,
    ppid: 999,
    args: "/bin/zsh -c IFS= builtin read -r -d '' __cursor_command <&5",
  };
  const python: ProcessRow = {
    pid: 501,
    ppid: 500,
    args: '/opt/homebrew/Python.app/Contents/MacOS/Python',
  };

  it('finds a heredoc through the CLI record, as its text is not in the table', () => {
    const alive = [wrapper, python];
    expect(isCommandRunning(alive, heredoc)).toBe(false);
    expect(
      commandLiveness(alive, [{ pid: 500, command: heredoc, running: true }])(
        heredoc,
      ),
    ).toBe(true);
  });

  it('reads a command as ended once its record says so, whatever the table holds', () => {
    const alive: ProcessRow[] = [{ pid: 7, ppid: 1, args: 'sleep 300' }];
    expect(
      commandLiveness(alive, [
        { pid: 7, command: 'sleep 300', running: false },
      ])('sleep 300'),
    ).toBe(false);
  });

  it('never counts a record whose process is outside this CLI', () => {
    expect(
      commandLiveness(
        [python],
        [{ pid: 500, command: heredoc, running: true }],
      )(heredoc),
    ).toBe(false);
  });

  it('gives each live record to one call of the lines written alike', () => {
    const stillRunning = commandLiveness(
      [{ pid: 7, ppid: 1, args: 'sleep 300' }],
      [
        { pid: 7, command: 'sleep 300', running: true },
        { pid: 8, command: 'sleep 300', running: false },
      ],
    );
    expect([stillRunning('sleep 300'), stillRunning('sleep 300')]).toEqual([
      true,
      false,
    ]);
  });

  it('falls back to the table for a line the CLI did not record', () => {
    const stillRunning = commandLiveness(
      [{ pid: 7, ppid: 1, args: 'pnpm dev' }],
      [{ pid: 8, command: 'other', running: true }],
    );
    expect(stillRunning('pnpm dev')).toBe(true);
    expect(stillRunning('pnpm build')).toBe(false);
  });

  it('compares lines with whitespace collapsed, as the table reports them', () => {
    expect(
      recordedPidsRunning(
        [wrapper],
        [{ pid: 500, command: 'a\n  b', running: true }],
        'a b',
      ),
    ).toEqual([500]);
  });
});
