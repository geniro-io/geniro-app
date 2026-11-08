import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cursorProjectSlug,
  cursorTerminalDirs,
  parseCursorTerminalHeader,
  readCursorTerminalRecords,
} from './cursor-terminals.utils';

/** A terminal file as cursor-agent 2026.11.05-86047df writes it. */
function terminalFile(
  fields: { pid?: string; command?: string; status?: string } = {},
): string {
  return [
    '---',
    `pid: ${fields.pid ?? '12971'}`,
    'cwd: "/proj"',
    `command: ${fields.command ?? JSON.stringify("python3 << 'PY'\nimport time\nPY")}`,
    'title: "Wait until the applies finish"',
    `status: ${fields.status ?? 'running  '}`,
    'started_at: 2026-11-08T12:41:02.871Z',
    'running_for_ms: 57166    ',
    '---',
    'output: not a field',
    '---',
    'exit_code: 0',
    '---',
    '',
  ].join('\n');
}

describe('cursorProjectSlug', () => {
  it('turns a folder into the directory name the CLI uses', () => {
    expect(
      cursorProjectSlug(
        '/Users/me/Library/Application Support/Geniro/worktrees/c90e-1992',
      ),
    ).toBe('Users-me-Library-Application-Support-Geniro-worktrees-c90e-1992');
  });

  it('collapses runs of separators and trims them', () => {
    expect(cursorProjectSlug('/tmp/claude-501/-Users-me/./x_y/')).toBe(
      'tmp-claude-501-Users-me-x-y',
    );
  });
});

describe('parseCursorTerminalHeader', () => {
  it('reads a running command written across lines', () => {
    expect(parseCursorTerminalHeader(terminalFile())).toEqual({
      pid: 12971,
      command: "python3 << 'PY'\nimport time\nPY",
      running: true,
    });
  });

  it('reads a finished command as not running', () => {
    expect(
      parseCursorTerminalHeader(terminalFile({ status: 'succeeded' }))?.running,
    ).toBe(false);
  });

  it('stops at the header, so output cannot pose as a field', () => {
    const text = terminalFile().replace(
      'output: not a field',
      'status: running',
    );
    expect(parseCursorTerminalHeader(text)).toEqual(
      expect.objectContaining({ pid: 12971 }),
    );
    expect(
      parseCursorTerminalHeader(
        terminalFile({ status: 'failed' }).replace(
          'output: not a field',
          'status: running',
        ),
      )?.running,
    ).toBe(false);
  });

  it.each([
    ['a file with no header', 'just output\n'],
    ['a header that never closes', '---\npid: 1\n'],
    ['a pid that is no number', terminalFile({ pid: 'abc' })],
    ['a pid of zero', terminalFile({ pid: '0' })],
    ['a command that is not quoted', terminalFile({ command: 'sleep 5' })],
    ['a command that is not a string', terminalFile({ command: '5' })],
    ['no status', terminalFile({ status: '' })],
  ])('refuses %s', (_name, text) => {
    expect(parseCursorTerminalHeader(text)).toBeNull();
  });
});

describe('cursorTerminalDirs', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('looks under ~/.cursor unless the run names a data directory', async () => {
    expect(await cursorTerminalDirs('/no/such/folder', {})).toEqual([
      join(homedir(), '.cursor', 'projects', 'no-such-folder', 'terminals'),
    ]);
    expect(
      await cursorTerminalDirs('/no/such/folder', {
        CURSOR_DATA_DIR: '/data/dir',
      }),
    ).toEqual(['/data/dir/projects/no-such-folder/terminals']);
  });

  it('asks for both spellings of a folder reached through a link', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-terminals-'));
    dirs.push(root);
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    const found = await cursorTerminalDirs(join(root, 'link'), {
      CURSOR_DATA_DIR: '/data',
    });
    expect(found).toHaveLength(2);
    expect(found.some((dir) => dir.includes('-real/'))).toBe(true);
    expect(found.some((dir) => dir.includes('-link/'))).toBe(true);
  });
});

describe('readCursorTerminalRecords', () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-terminals-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads what was written since the process started', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '1.txt'), terminalFile({ pid: '11' }));
    writeFileSync(join(dir, '2.txt'), terminalFile({ pid: '22' }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, '1.txt'), old, old);

    const records = await readCursorTerminalRecords([dir], Date.now() - 30_000);

    expect(records.map((record) => record.pid)).toEqual([22]);
  });

  it('reads a file again only once it has moved', async () => {
    const dir = tempDir();
    const path = join(dir, '4.txt');
    const stamp = new Date(Date.now() - 1000);
    writeFileSync(path, terminalFile({ status: 'running' }));
    utimesSync(path, stamp, stamp);
    const cache = new Map();
    const runningNow = async () =>
      (await readCursorTerminalRecords([dir], 0, cache))[0]?.running;
    expect(await runningNow()).toBe(true);

    writeFileSync(path, terminalFile({ status: 'succeeded' }));
    utimesSync(path, stamp, stamp);
    expect(await runningNow()).toBe(true);

    const later = new Date(Date.now());
    utimesSync(path, later, later);
    expect(await runningNow()).toBe(false);
  });

  it('skips what is not a record and a folder that is not there', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'notes.md'), terminalFile());
    writeFileSync(join(dir, '3.txt'), 'no header\n');
    mkdirSync(join(dir, 'dir.txt'));

    expect(
      await readCursorTerminalRecords([dir, join(dir, 'missing')], 0),
    ).toEqual([]);
  });
});
