import { describe, expect, it } from 'vitest';

import {
  decodePsText,
  parseElapsed,
  parseProcessUsage,
  processName,
  processTreeOf,
  type ProcessUsageRow,
} from './process-usage';

const CURSOR =
  '/Users/me/Library/Application Support/Cursor/agent-cli/.local/bin/cursor-agent';

function row(
  pid: number,
  ppid: number,
  pgid: number,
  args = `proc-${pid}`,
): ProcessUsageRow {
  return {
    pid,
    ppid,
    pgid,
    args,
    comm: null,
    cpuPercent: 1,
    rssBytes: 1024,
    elapsedSeconds: 10,
  };
}

describe('parseProcessUsage', () => {
  it('reads every column, in bytes and seconds, and pairs each row with its comm', () => {
    const rows = parseProcessUsage(
      [
        `  700     1   700  12.5  20480 01:02:03 ${CURSOR} --use-system-ca acp`,
        '  701   700   700   0,4   1024    00:07 node /usr/local/bin/codegraph serve',
      ].join('\n'),
      [`  700 ${CURSOR}`, '  701 node'].join('\n'),
    );
    expect(rows).toEqual([
      {
        pid: 700,
        ppid: 1,
        pgid: 700,
        cpuPercent: 12.5,
        rssBytes: 20480 * 1024,
        elapsedSeconds: 3723,
        args: `${CURSOR} --use-system-ca acp`,
        comm: CURSOR,
      },
      {
        pid: 701,
        ppid: 700,
        pgid: 700,
        // A comma-decimal locale must not end the number early.
        cpuPercent: 0.4,
        rssBytes: 1024 * 1024,
        elapsedSeconds: 7,
        args: 'node /usr/local/bin/codegraph serve',
        comm: 'node',
      },
    ]);
  });

  it('skips a line that does not parse instead of reading it as pid 0', () => {
    expect(
      parseProcessUsage('  PID  PPID\nps: warning\n    0 0 0 0 0 00:01 x', ''),
    ).toEqual([]);
  });
});

describe('decodePsText', () => {
  it('turns `ps`’s vis escapes back into the newline and UTF-8 they stand for', () => {
    // Measured: a claude system prompt reached the panel as
    // `## How\\012\\012You … markdown M-bM^@M^T they are not`.
    expect(decodePsText('a\\012b markdown M-bM^@M^T done')).toBe(
      'a\nb markdown \u2014 done',
    );
  });

  it('leaves text alone that only LOOKS like an escape — `ps` escapes no literal', () => {
    expect(decodePsText('grep -M-b \\builtin')).toBe('grep -M-b \\builtin');
  });

  it('decodes a row as it is parsed', () => {
    const [parsed] = parseProcessUsage(
      '  700     1   700   0.0   1024 00:07 node -e \\012const x = 1',
      '',
    );
    expect(parsed?.args).toBe('node -e \nconst x = 1');
  });
});

describe('parseElapsed', () => {
  it.each([
    ['00:07', 7],
    ['12:34', 754],
    ['01:00:00', 3600],
    ['2-03:04:05', 2 * 86_400 + 3 * 3600 + 4 * 60 + 5],
  ])('%s is %d seconds', (etime, seconds) => {
    expect(parseElapsed(etime)).toBe(seconds);
  });

  it('answers null for anything else', () => {
    expect(parseElapsed('soon')).toBeNull();
  });
});

describe('processName', () => {
  it('names an executable whose path holds spaces by its comm, not by its first word', () => {
    expect(processName({ args: `${CURSOR} acp`, comm: CURSOR })).toBe(
      'cursor-agent',
    );
  });

  it('names an interpreter by the script it runs, skipping its flags', () => {
    expect(
      processName({
        args: 'node --max-old-space-size=4096 /usr/local/bin/codegraph serve',
        comm: 'node',
      }),
    ).toBe('codegraph');
  });

  it('keeps a retitled process its own name — `npm exec` is npm, not its argument', () => {
    expect(
      processName({ args: 'npm exec @playwright/mcp@latest', comm: 'node' }),
    ).toBe('npm');
  });

  it('a retitled process is named by its title’s first word, not its comm’s last', () => {
    // npm reports its own title as comm, so matching argv0 against it would
    // name the process after the package it runs.
    expect(
      processName({
        args: 'npm exec @playwright/mcp@latest',
        comm: 'npm exec @playwright/mcp@latest',
      }),
    ).toBe('npm');
  });

  it('names an interpreter running INLINE code after itself, not after the code', () => {
    expect(
      processName({ args: 'node -e \nconst fs = require("fs")', comm: 'node' }),
    ).toBe('node');
  });

  it('a shell is a shell', () => {
    expect(
      processName({ args: '/bin/zsh -c sleep 300', comm: '/bin/zsh' }),
    ).toBe('zsh');
  });
});

describe('processTreeOf', () => {
  it('lists the CLI first, then its tree depth-first by pid', () => {
    const rows = [
      row(1, 0, 1),
      row(100, 50, 100), // the CLI, led group
      row(103, 100, 100),
      row(101, 100, 100),
      row(102, 101, 100),
      row(200, 50, 200), // another run's CLI
    ];
    expect(
      processTreeOf(rows, 100).map((p) => [p.pid, p.depth, p.link]),
    ).toEqual([
      [100, 0, 'root'],
      [101, 1, 'child'],
      [102, 2, 'child'],
      [103, 1, 'child'],
    ]);
  });

  it('keeps a command reparented to launchd, through the group the spawn created', () => {
    const rows = [
      row(100, 50, 100),
      row(150, 1, 100, 'pnpm dev'), // its shell exited
      row(151, 150, 100, 'next dev'),
      row(300, 1, 300, 'somebody else'),
    ];
    expect(
      processTreeOf(rows, 100).map((p) => [p.pid, p.depth, p.link]),
    ).toEqual([
      [100, 0, 'root'],
      [150, 1, 'group'],
      [151, 2, 'child'],
    ]);
  });

  it('claims no group the root does not lead — that group is its spawner’s', () => {
    const rows = [row(50, 1, 50), row(100, 50, 50), row(60, 50, 50)];
    expect(processTreeOf(rows, 100).map((p) => p.pid)).toEqual([100]);
  });

  it('answers nothing for a CLI that has already gone', () => {
    expect(processTreeOf([row(101, 100, 100)], 100)).toEqual([]);
  });

  it('survives a cycle in a non-atomic snapshot', () => {
    const rows = [row(100, 50, 100), row(101, 102, 100), row(102, 101, 100)];
    expect(
      processTreeOf(rows, 100)
        .map((p) => p.pid)
        .sort(),
    ).toEqual([100, 101, 102]);
  });
});
