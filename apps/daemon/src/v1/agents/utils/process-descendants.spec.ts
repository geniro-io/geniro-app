import { describe, expect, it } from 'vitest';

import {
  descendantsOf,
  isCommandRunning,
  parseProcessRows,
  type ProcessRow,
} from './process-descendants';

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
