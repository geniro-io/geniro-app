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
 * What it can catch is the regression it is named for and nothing subtler: the
 * search-text backfill acquiring one of the two boot-path shapes its sibling
 * sweeps use. Both of those are correct for their own bounded work and wrong
 * for this one, which walks every transcript row the app has ever written
 * (~160,000 on a real profile) — Nest awaits `onModuleInit` before the socket
 * binds, so either shape holds the pidfile write and the `GENIRO_DAEMON_READY`
 * print behind the whole sweep, and the app looks hung on the first launch
 * after an update.
 */
const source = readFileSync(join(__dirname, 'main.ts'), 'utf8');

describe('the search-text backfill stays OFF the boot path', () => {
  it('is started un-awaited, so nothing about the handshake waits on it', () => {
    expect(source).toContain('void searchTextBackfill?.backfillQuietly();');
    // The `void` is the whole of it, so the failure worth naming is the shape
    // that reads as an improvement: awaiting it.
    expect(source).not.toMatch(/await\s+searchTextBackfill/);
  });

  it('is started AFTER the ready print, not before it', () => {
    const ready = source.indexOf('GENIRO_DAEMON_READY');
    const backfill = source.indexOf('backfillQuietly');
    expect(ready).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(ready);
  });

  it('is not registered as a lifecycle hook of its own', () => {
    // `onModuleInit` is where both sibling backfills live, and it is exactly
    // the hook Nest awaits before the socket binds.
    expect(source).not.toMatch(
      /SearchTextBackfillService[\s\S]{0,200}onModuleInit/,
    );
  });
});
