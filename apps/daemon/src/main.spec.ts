import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A SOURCE-reading spec, like the renderer's catalog and theme-token ones, and
 * for the same reason: there is no runtime observable to assert on. `main.ts`
 * boots the whole daemon at module scope, so importing it here would start a
 * server — and the property that matters is not what the boot DOES but the
 * SHAPE of one call inside it.
 *
 * What it can catch is the regression each block is named for and nothing
 * subtler: a sweep over the whole history acquiring a boot-path shape. Nest
 * awaits `onModuleInit` before the socket binds, so either an await there or
 * one in the pre-listen callback holds the pidfile write and the
 * `GENIRO_DAEMON_READY` print behind the whole sweep, and the app looks hung on
 * the first launch after an update.
 */
const source = readFileSync(join(__dirname, 'main.ts'), 'utf8');

describe('the call-membership sweep stays OFF the boot path', () => {
  it('is started un-awaited, after the ready print', () => {
    expect(source).toContain('void callIndex?.indexAllQuietly();');
    expect(source).not.toMatch(/await\s+callIndex/);
    expect(source.indexOf('indexAllQuietly')).toBeGreaterThan(
      source.indexOf('GENIRO_DAEMON_READY'),
    );
  });
});

describe('the wall-work sweep stays OFF the boot path', () => {
  it('is started un-awaited, after the ready print', () => {
    expect(source).toContain('void wallWork?.sweepAllQuietly();');
    expect(source).not.toMatch(/await\s+wallWork/);
    expect(source.indexOf('sweepAllQuietly')).toBeGreaterThan(
      source.indexOf('GENIRO_DAEMON_READY'),
    );
  });
});

describe('the pull-request re-scan stays OFF the boot path', () => {
  it('is started un-awaited, after the ready print', () => {
    expect(source).toContain('void pullRequests?.rescanOutdatedQuietly();');
    expect(source).not.toMatch(/await\s+pullRequests/);
    expect(source.indexOf('rescanOutdatedQuietly')).toBeGreaterThan(
      source.indexOf('GENIRO_DAEMON_READY'),
    );
  });
});

describe('a crash leaves its mark', () => {
  it('hands the crash guards the writer of the crash mark', () => {
    // A crash exits by the same SIGTERM as the idle exit; without the mark the
    // supervisor reads it as a requested stop and leaves the daemon down.
    expect(source).toMatch(
      /installCrashGuards\(\{\s*markCrash: \(\) => writeCrashMark\(environment\.userDataDir, process\.pid\)/,
    );
  });
});
