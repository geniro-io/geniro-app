import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  consumeCrashMark,
  DAEMON_CRASH_MARK_NAME,
  DAEMON_LOOPBACK_HOST,
  DAEMON_MIGRATING_PREFIX,
  DAEMON_MIGRATION_ERROR_NAME,
  DAEMON_MIGRATION_EXIT_CODE,
  DAEMON_STOP_CAUSE_NAME,
  type DaemonInfo,
  type DaemonStopCause,
  parseDaemonInfo,
  parseMigratingLine,
  readDaemonInfo,
  readMigrationError,
  stampEntry,
  writeStopCause,
} from './daemon-pidfile';

describe('the entry stamp — the twin parser’s only mechanical link', () => {
  it('parses the exact JSON the daemon writes', () => {
    // The daemon builds this object in `apps/daemon/src/utils/handshake.ts`
    // `stampEntry` and it reaches here through JSON. If either side renames a
    // key, every daemon reads as unstamped and is replaced on every launch —
    // and nothing else in either suite would notice.
    const parsed = parseDaemonInfo({
      pid: 1,
      host: DAEMON_LOOPBACK_HOST,
      port: 4823,
      token: 't',
      version: '0.1.0',
      entry: { path: '/bundle/daemon/dist/main.js', mtimeMs: 17, size: 8508 },
      pidStartedAtMs: 5_000,
      startedAt: '2026-08-10T00:00:00Z',
    });
    expect(parsed?.entry).toEqual({
      path: '/bundle/daemon/dist/main.js',
      mtimeMs: 17,
      size: 8508,
    });
  });

  it('round-trips a stamp this side produced through JSON', () => {
    const stamped = stampEntry('/bundle/daemon/dist/main.js', () => ({
      mtimeMs: 17,
      size: 8508,
    }));
    const wire: unknown = JSON.parse(JSON.stringify(stamped));
    expect(
      parseDaemonInfo({
        pid: 1,
        host: DAEMON_LOOPBACK_HOST,
        port: 4823,
        token: 't',
        version: '0.1.0',
        entry: wire,
        pidStartedAtMs: 5_000,
        startedAt: '2026-08-10T00:00:00Z',
      })?.entry,
    ).toEqual(stamped);
  });

  it('refuses a pidfile whose stamp has no usable path', () => {
    // Not the same as a valid stamp with null numbers: a stamp naming no file
    // cannot be compared to anything, so it must not present as comparable.
    for (const entry of [null, 'x', {}, { path: '' }, { mtimeMs: 1 }]) {
      expect(
        parseDaemonInfo({
          pid: 1,
          host: DAEMON_LOOPBACK_HOST,
          port: 4823,
          token: 't',
          version: '0.1.0',
          entry,
          pidStartedAtMs: 5_000,
          startedAt: '2026-08-10T00:00:00Z',
        }),
      ).toBeNull();
    }
  });

  it('nulls a non-finite mtime or size rather than carrying it through', () => {
    const parsed = parseDaemonInfo({
      pid: 1,
      host: DAEMON_LOOPBACK_HOST,
      port: 4823,
      token: 't',
      version: '0.1.0',
      entry: { path: '/x/main.js', mtimeMs: 'soon', size: null },
      pidStartedAtMs: 5_000,
      startedAt: '2026-08-10T00:00:00Z',
    });
    expect(parsed?.entry).toEqual({
      path: '/x/main.js',
      mtimeMs: null,
      size: null,
    });
  });

  it('refuses a pidfile with no entry or no start time', () => {
    const base = {
      pid: 1,
      host: DAEMON_LOOPBACK_HOST,
      port: 4823,
      token: 't',
      version: '0.1.0',
      startedAt: '2026-08-10T00:00:00Z',
    };
    expect(parseDaemonInfo({ ...base, pidStartedAtMs: 5_000 })).toBeNull();
    expect(
      parseDaemonInfo({ ...base, entry: { path: '/x/main.js' } }),
    ).toBeNull();
  });
});

function valid(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
  return {
    pid: 123,
    host: DAEMON_LOOPBACK_HOST,
    port: 4823,
    token: 'token',
    version: '1.0.0',
    entry: { path: '/x/main.js', mtimeMs: 1, size: 2 },
    pidStartedAtMs: 5_000,
    startedAt: '2026-07-10T00:00:00Z',
    ...overrides,
  };
}

describe('parseDaemonInfo', () => {
  it('accepts the daemon contract loopback host', () => {
    expect(parseDaemonInfo(valid())).toEqual(valid());
  });

  it.each(['localhost', '::1', '192.168.1.10', 'example.com'])(
    'rejects non-contract host %s so bearer traffic cannot leave loopback',
    (host) => {
      expect(parseDaemonInfo(valid({ host }))).toBeNull();
    },
  );

  it('rejects malformed process and port coordinates', () => {
    expect(parseDaemonInfo(valid({ pid: 0 }))).toBeNull();
    expect(parseDaemonInfo(valid({ port: 65_536 }))).toBeNull();
  });

  it('rejects a non-integer pid', () => {
    expect(parseDaemonInfo(valid({ pid: 1.5 }))).toBeNull();
  });

  it('rejects an empty token — adopting it would 401 every bearer request', () => {
    expect(parseDaemonInfo(valid({ token: '' }))).toBeNull();
  });

  it('rejects a missing or non-string version', () => {
    const missingVersion: Partial<DaemonInfo> = { ...valid() };
    delete missingVersion.version;
    expect(parseDaemonInfo(missingVersion)).toBeNull();
    expect(parseDaemonInfo({ ...valid(), version: 100 })).toBeNull();
  });

  it('rejects a missing or non-string startedAt', () => {
    const missingStartedAt: Partial<DaemonInfo> = { ...valid() };
    delete missingStartedAt.startedAt;
    expect(parseDaemonInfo(missingStartedAt)).toBeNull();
    expect(
      parseDaemonInfo({ ...valid(), startedAt: 1_720_000_000_000 }),
    ).toBeNull();
  });

  it('rejects a non-object payload', () => {
    expect(parseDaemonInfo(null)).toBeNull();
    // A JSON string of the right shape is still not the object itself.
    expect(parseDaemonInfo(JSON.stringify(valid()))).toBeNull();
  });
});

describe('readDaemonInfo', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-pidfile-spec-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a valid pidfile (control for the null cases below)', () => {
    const path = join(dir, 'daemon.json');
    writeFileSync(path, JSON.stringify(valid()), 'utf8');

    expect(readDaemonInfo(path)).toEqual(valid());
  });

  it('returns null for an absent file', () => {
    expect(readDaemonInfo(join(dir, 'daemon.json'))).toBeNull();
  });

  it('returns null for a file containing invalid JSON', () => {
    const path = join(dir, 'daemon.json');
    writeFileSync(path, '{ pid: 123, oops', 'utf8');

    expect(readDaemonInfo(path)).toBeNull();
  });
});

describe('consumeCrashMark', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-crash-mark-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('says the daemon crashed when the mark names its pid, and removes it', () => {
    const path = join(dir, 'daemon-crashed');
    writeFileSync(path, '4242');

    expect(consumeCrashMark(path, 4242)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('reads a mark naming another pid as a leftover, and removes it too', () => {
    const path = join(dir, 'daemon-crashed');
    writeFileSync(path, '1111');

    expect(consumeCrashMark(path, 4242)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('reads no mark as no crash', () => {
    expect(consumeCrashMark(join(dir, 'daemon-crashed'), 4242)).toBe(false);
  });
});

describe('DAEMON_CRASH_MARK_NAME', () => {
  it('names the file the daemon writes', () => {
    // Two apps, no shared module: a rename on one side leaves every crash
    // read as a requested stop, with both suites green on their own.
    const daemon = readFileSync(
      join(__dirname, '../../../daemon/src/utils/handshake.ts'),
      'utf8',
    );
    expect(daemon).toContain(
      `export const DAEMON_CRASH_MARK_NAME = '${DAEMON_CRASH_MARK_NAME}';`,
    );
  });
});

describe('writeStopCause', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-stop-cause-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces any earlier note with the cause, owner-only', () => {
    const path = join(dir, DAEMON_STOP_CAUSE_NAME);
    writeFileSync(path, 'crash');

    writeStopCause(path, 'self-update');

    expect(readFileSync(path, 'utf8')).toBe('self-update');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('replaces a leftover at the staging name rather than writing through it', () => {
    const path = join(dir, DAEMON_STOP_CAUSE_NAME);
    const decoy = join(dir, 'decoy');
    writeFileSync(decoy, 'untouched', { mode: 0o644 });
    symlinkSync(decoy, `${path}.${process.pid}.tmp`);

    writeStopCause(path, 'quit');

    expect(readFileSync(decoy, 'utf8')).toBe('untouched');
    expect(readFileSync(path, 'utf8')).toBe('quit');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('DAEMON_STOP_CAUSE_NAME', () => {
  it('names the file the daemon reads, and the daemon knows every cause written', () => {
    // A rename on one side, or a cause the daemon's list lacks, reads every
    // stop as `unknown` — which blocks cards a quit should have continued.
    const daemon = readFileSync(
      join(__dirname, '../../../daemon/src/utils/handshake.ts'),
      'utf8',
    );
    expect(daemon).toContain(
      `export const DAEMON_STOP_CAUSE_NAME = '${DAEMON_STOP_CAUSE_NAME}';`,
    );
    const causes = readFileSync(
      join(__dirname, '../../../daemon/src/utils/stop-cause.ts'),
      'utf8',
    );
    // Total over the type, so a cause added to the UI fails to compile here
    // until it is checked against the daemon too.
    const written = {
      quit: true,
      'self-update': true,
      restart: true,
      crash: true,
    } satisfies Record<DaemonStopCause, true>;
    for (const cause of Object.keys(written)) {
      expect(causes).toContain(`'${cause}',`);
    }
  });
});

describe('the migration handshake', () => {
  it('names the prefix, exit code and report file the daemon uses', () => {
    // No shared module: a rename on one side leaves a long migration killed at
    // the start deadline, or a failing one respawned, with both suites green.
    const daemon = readFileSync(
      join(__dirname, '../../../daemon/src/v1/migrations/migrations.types.ts'),
      'utf8',
    );
    expect(daemon).toContain(
      `export const MIGRATING_LINE_PREFIX = '${DAEMON_MIGRATING_PREFIX}';`,
    );
    expect(daemon).toContain(
      `export const MIGRATION_FAILED_EXIT_CODE = ${DAEMON_MIGRATION_EXIT_CODE};`,
    );
    expect(daemon).toContain(
      `export const MIGRATION_ERROR_FILE = '${DAEMON_MIGRATION_ERROR_NAME}';`,
    );
  });
});

describe('parseMigratingLine', () => {
  it('reads a step line', () => {
    expect(
      parseMigratingLine(
        'GENIRO_DAEMON_MIGRATING {"id":"0002-x","step":1,"of":2}',
      ),
    ).toEqual({ id: '0002-x', step: 1, of: 2 });
  });

  it('reads nothing from any other line', () => {
    for (const line of [
      'GENIRO_DAEMON_READY {"port":1}',
      'GENIRO_DAEMON_MIGRATING {"id":"0002-x",',
      'GENIRO_DAEMON_MIGRATING {"id":"0002-x","step":3,"of":2}',
      'GENIRO_DAEMON_MIGRATING {"id":"0002-x","step":0,"of":2}',
      'GENIRO_DAEMON_MIGRATING ["0002-x",1,2]',
      ' GENIRO_DAEMON_MIGRATING {"id":"0002-x","step":1,"of":2}',
    ]) {
      expect(parseMigratingLine(line)).toBeNull();
    }
  });
});

describe('readMigrationError', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-migration-error-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the daemon's report", () => {
    const path = join(dir, DAEMON_MIGRATION_ERROR_NAME);
    writeFileSync(
      path,
      JSON.stringify({
        id: '0002-x',
        step: 2,
        of: 2,
        kind: 'files',
        message: 'EACCES',
        backupDir: '/b',
        appVersion: '1.0.0',
        at: '2026-11-01T00:00:00.000Z',
      }),
    );

    expect(readMigrationError(path)).toEqual({
      id: '0002-x',
      step: 2,
      of: 2,
      kind: 'files',
      message: 'EACCES',
      backupDir: '/b',
    });
  });

  it('fills what a report leaves out, and reads nothing from an unreadable one', () => {
    const path = join(dir, DAEMON_MIGRATION_ERROR_NAME);
    writeFileSync(path, JSON.stringify({ id: '0002-x', step: 1, of: 1 }));
    expect(readMigrationError(path)).toEqual({
      id: '0002-x',
      step: 1,
      of: 1,
      kind: null,
      message: '',
      backupDir: null,
    });

    writeFileSync(path, '{ torn');
    expect(readMigrationError(path)).toBeNull();
    expect(readMigrationError(join(dir, 'missing.json'))).toBeNull();
  });
});
