import { describe, expect, it } from 'vitest';

import {
  commandLiveness,
  commandNeedles,
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

    expect(endedRecordOf(records, 'make\ntest')?.pid).toBe(2);
    expect(endedRecordOf(records, 'make lint')).toBeNull();
    expect(
      endedRecordOf([{ pid: 9, command: 'x y', running: true }], 'x y'),
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

  it('keeps nothing too short to be specific', () => {
    expect(commandNeedles('ls')).toEqual([]);
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
