import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearSecrets, registerSecret } from '../v1/diagnostics/utils/redact';
import { DAEMON_EXIT_NOTE_NAME, DAEMON_STOP_CAUSE_NAME } from './handshake';
import {
  composeStopDetail,
  consumePreviousStopRecords,
  DAEMON_HEARTBEAT_NAME,
  DAEMON_LAST_ERROR_NAME,
  type DaemonExitNote,
  type DaemonHeartbeat,
  type DaemonLastError,
  formatMemory,
  type PreviousStopRecords,
  readPreviousStop,
  summarizeError,
  writeHeartbeat,
  writeLastError,
} from './previous-stop';

const KIB = 1024;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const BOOTED_AT = Date.UTC(2026, 10, 24, 10, 21, 47);
const BEAT_BEFORE_BOOT = Date.UTC(2026, 10, 24, 10, 20, 53);
const BEAT_AFTER_BOOT = Date.UTC(2026, 10, 24, 10, 23, 0);
const NONE: PreviousStopRecords = {
  heartbeat: null,
  exit: null,
  lastError: null,
};

function heartbeat(at: number = BEAT_BEFORE_BOOT): DaemonHeartbeat {
  return {
    pid: 100,
    startedAt: Date.UTC(2026, 10, 24, 9, 0, 0),
    at,
    rssBytes: 1.2 * GIB,
  };
}

function exitNote(
  code: number | null,
  signal: string | null = null,
): DaemonExitNote {
  return { pid: 100, code, signal, at: '2026-11-24T10:21:01.000Z' };
}

function lastError(overrides: Partial<DaemonLastError> = {}): DaemonLastError {
  return {
    pid: 100,
    name: 'TypeError',
    message: 'boom',
    where: 'team-executor.service',
    at: BEAT_BEFORE_BOOT,
    ...overrides,
  };
}

function errorWithStack(stack: string): Error {
  const err = new Error('boom');
  err.stack = stack;
  return err;
}

describe('composeStopDetail', () => {
  it('names an uncaught error over every other record', () => {
    expect(
      composeStopDetail(
        {
          heartbeat: heartbeat(),
          exit: exitNote(null, 'SIGKILL'),
          lastError: lastError(),
        },
        BOOTED_AT,
      ),
    ).toBe('uncaught TypeError in team-executor.service: boom');
  });

  it.each([
    [{ where: null, message: '' }, 'uncaught TypeError'],
    [{ where: null, message: 'boom' }, 'uncaught TypeError: boom'],
    [
      { where: 'team-executor.service', message: '' },
      'uncaught TypeError in team-executor.service',
    ],
  ] as const)(
    'leaves out a place or message that is missing: %j',
    (fields, detail) => {
      expect(
        composeStopDetail({ ...NONE, lastError: lastError(fields) }, BOOTED_AT),
      ).toBe(detail);
    },
  );

  it('names a signal with the memory the last heartbeat reported', () => {
    expect(
      composeStopDetail(
        { ...NONE, heartbeat: heartbeat(), exit: exitNote(null, 'SIGKILL') },
        BOOTED_AT,
      ),
    ).toBe('killed by SIGKILL (memory 1.2 GB)');
  });

  it('names a signal alone when no heartbeat was left', () => {
    expect(
      composeStopDetail(
        { ...NONE, exit: exitNote(null, 'SIGKILL') },
        BOOTED_AT,
      ),
    ).toBe('killed by SIGKILL');
  });

  it('names a non-zero exit code with the memory', () => {
    expect(
      composeStopDetail(
        { ...NONE, heartbeat: heartbeat(), exit: exitNote(1) },
        BOOTED_AT,
      ),
    ).toBe('exited with code 1 (memory 1.2 GB)');
  });

  it('names a zero exit code as a daemon that ended on its own', () => {
    expect(
      composeStopDetail(
        { ...NONE, heartbeat: heartbeat(), exit: exitNote(0) },
        BOOTED_AT,
      ),
    ).toBe('exited on its own (memory 1.2 GB)');
  });

  it('reads a heartbeat older than the Mac’s boot as a shutdown or restart', () => {
    expect(
      composeStopDetail(
        { ...NONE, heartbeat: heartbeat(BEAT_BEFORE_BOOT) },
        BOOTED_AT,
      ),
    ).toBe(
      'the Mac shut down or restarted; last heartbeat 2026-11-24T10:20:53Z, memory 1.2 GB',
    );
  });

  it('reads a heartbeat newer than the Mac’s boot as a stop nobody recorded', () => {
    expect(
      composeStopDetail(
        { ...NONE, heartbeat: heartbeat(BEAT_AFTER_BOOT) },
        BOOTED_AT,
      ),
    ).toBe(
      'no exit was recorded; last heartbeat 2026-11-24T10:23:00Z, memory 1.2 GB',
    );
  });

  it('names nothing when no record says how the daemon ended', () => {
    expect(composeStopDetail(NONE, BOOTED_AT)).toBeNull();
    expect(
      composeStopDetail({ ...NONE, exit: exitNote(null) }, BOOTED_AT),
    ).toBeNull();
  });
});

describe('formatMemory', () => {
  it.each([
    [1.2 * GIB, '1.2 GB'],
    [GIB, '1.0 GB'],
    [3.5 * GIB, '3.5 GB'],
    [1023 * MIB, '1023 MB'],
    [512 * MIB, '512 MB'],
    [100 * KIB, '1 MB'],
    [0, '1 MB'],
  ] as const)('formats %d bytes as %s', (bytes, text) => {
    expect(formatMemory(bytes)).toBe(text);
  });
});

describe('summarizeError', () => {
  afterEach(() => {
    clearSecrets();
  });

  it('names the error by its name', () => {
    expect(summarizeError(new TypeError('boom')).name).toBe('TypeError');
  });

  it('names a value that is not an Error by its type', () => {
    expect(summarizeError('plain failure')).toEqual({
      name: 'string',
      message: 'plain failure',
      where: null,
    });
  });

  it('keeps only the first line of the message, trimmed', () => {
    expect(
      summarizeError(new Error('  first line  \nsecond line')).message,
    ).toBe('first line');
  });

  it('masks a registered secret in the message', () => {
    registerSecret('sk-live-0123456789abcdef', 'the API key');

    expect(
      summarizeError(new Error('token sk-live-0123456789abcdef was refused'))
        .message,
    ).toBe('token ‹the API key redacted› was refused');
  });

  it('keeps a message of 160 characters whole', () => {
    expect(summarizeError(new Error('x'.repeat(160))).message).toBe(
      'x'.repeat(160),
    );
  });

  it('cuts a longer message to 160 characters, the last one an ellipsis', () => {
    expect(summarizeError(new Error('x'.repeat(300))).message).toBe(
      `${'x'.repeat(159)}…`,
    );
  });

  it.each([
    [
      'at run (/srv/daemon/src/team-executor.service.ts:10:3)',
      'team-executor.service',
    ],
    ['at file:///srv/daemon/dist/previous-stop.js:10:5', 'previous-stop'],
  ] as const)('names the top frame %s by its file name', (frame, where) => {
    expect(
      summarizeError(errorWithStack(`Error: boom\n    ${frame}`)).where,
    ).toBe(where);
  });

  it('skips frames with no file path and names the first one that has one', () => {
    expect(
      summarizeError(
        errorWithStack(
          'Error: boom\n    at new Promise (<anonymous>)\n    at run (/srv/daemon/src/main.ts:5:1)',
        ),
      ).where,
    ).toBe('main');
  });

  it('names no place when no frame has a file path', () => {
    expect(
      summarizeError(
        errorWithStack(
          'Error: boom\n    at Object.<anonymous> (node:internal/main:1:1)',
        ),
      ).where,
    ).toBeNull();
  });
});

describe('record files', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-previous-stop-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the heartbeat as 0600 JSON and leaves no staged file behind', () => {
    writeHeartbeat(dir, heartbeat());

    const path = join(dir, DAEMON_HEARTBEAT_NAME);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(heartbeat());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([DAEMON_HEARTBEAT_NAME]);
  });

  it('replaces the previous heartbeat in place', () => {
    writeHeartbeat(dir, heartbeat(BEAT_BEFORE_BOOT));
    writeHeartbeat(dir, heartbeat(BEAT_AFTER_BOOT));

    const path = join(dir, DAEMON_HEARTBEAT_NAME);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      at: BEAT_AFTER_BOOT,
    });
    expect(readdirSync(dir)).toEqual([DAEMON_HEARTBEAT_NAME]);
  });

  it('writes the last error as 0600 JSON with its summary', () => {
    const err = errorWithStack(
      'TypeError: boom\n    at run (/srv/daemon/src/team-executor.service.ts:10:3)',
    );
    err.name = 'TypeError';

    writeLastError(dir, 77, err, 1234);

    const path = join(dir, DAEMON_LAST_ERROR_NAME);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      pid: 77,
      name: 'TypeError',
      message: 'boom',
      where: 'team-executor.service',
      at: 1234,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('consumePreviousStopRecords', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-previous-stop-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function leave(name: string, body: unknown): void {
    writeFileSync(
      join(dir, name),
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  }

  it('reads every record and removes all three files', () => {
    leave(DAEMON_HEARTBEAT_NAME, heartbeat());
    leave(DAEMON_EXIT_NOTE_NAME, exitNote(null, 'SIGKILL'));
    leave(DAEMON_LAST_ERROR_NAME, lastError());

    expect(consumePreviousStopRecords(dir)).toEqual({
      heartbeat: heartbeat(),
      exit: exitNote(null, 'SIGKILL'),
      lastError: lastError(),
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('drops an exit note and a last error that the heartbeat does not name', () => {
    leave(DAEMON_HEARTBEAT_NAME, heartbeat());
    leave(DAEMON_EXIT_NOTE_NAME, { ...exitNote(1), pid: 99 });
    leave(DAEMON_LAST_ERROR_NAME, lastError({ pid: 98 }));

    const records = consumePreviousStopRecords(dir);

    expect(records.heartbeat).toEqual(heartbeat());
    expect(records.exit).toBeNull();
    expect(records.lastError).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('takes the pid from the last error when the heartbeat is unreadable', () => {
    leave(DAEMON_HEARTBEAT_NAME, '{not json');
    leave(DAEMON_EXIT_NOTE_NAME, { ...exitNote(1), pid: 99 });
    leave(DAEMON_LAST_ERROR_NAME, lastError({ pid: 98 }));

    expect(consumePreviousStopRecords(dir)).toEqual({
      heartbeat: null,
      exit: null,
      lastError: lastError({ pid: 98 }),
    });
  });

  it('reads no record, and removes an unreadable one, without failing', () => {
    expect(consumePreviousStopRecords(dir)).toEqual(NONE);

    leave(DAEMON_HEARTBEAT_NAME, '{not json');
    leave(DAEMON_EXIT_NOTE_NAME, { pid: 'x', code: 1, at: 'n/a' });

    expect(consumePreviousStopRecords(dir)).toEqual(NONE);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ['SIGKILL', 'SIGKILL'],
    ['kill', null],
    ['sigkill', null],
  ] as const)('reads the exit signal %s as %s', (signal, expected) => {
    leave(DAEMON_EXIT_NOTE_NAME, { ...exitNote(null), signal });

    expect(consumePreviousStopRecords(dir).exit?.signal ?? null).toBe(expected);
  });
});

describe('readPreviousStop', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-previous-stop-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function leave(name: string, body: unknown): void {
    writeFileSync(
      join(dir, name),
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  }

  it.each(['quit', 'self-update', 'restart'] as const)(
    'gives no detail after a %s, and still removes the records it left',
    (cause) => {
      leave(DAEMON_STOP_CAUSE_NAME, `${cause}\n`);
      leave(DAEMON_HEARTBEAT_NAME, heartbeat());
      leave(DAEMON_LAST_ERROR_NAME, lastError());

      expect(readPreviousStop(dir, BOOTED_AT)).toEqual({
        cause,
        detail: null,
      });
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  it('names a crash from the records it left', () => {
    leave(DAEMON_STOP_CAUSE_NAME, 'crash\n');
    leave(DAEMON_HEARTBEAT_NAME, heartbeat());
    leave(DAEMON_LAST_ERROR_NAME, lastError());

    expect(readPreviousStop(dir, BOOTED_AT)).toEqual({
      cause: 'crash',
      detail: 'uncaught TypeError in team-executor.service: boom',
    });
  });

  it('names a stop nobody announced from the heartbeat alone', () => {
    leave(DAEMON_HEARTBEAT_NAME, heartbeat(BEAT_BEFORE_BOOT));

    expect(readPreviousStop(dir, BOOTED_AT)).toEqual({
      cause: 'unknown',
      detail:
        'the Mac shut down or restarted; last heartbeat 2026-11-24T10:20:53Z, memory 1.2 GB',
    });
    expect(existsSync(join(dir, DAEMON_HEARTBEAT_NAME))).toBe(false);
  });
});
