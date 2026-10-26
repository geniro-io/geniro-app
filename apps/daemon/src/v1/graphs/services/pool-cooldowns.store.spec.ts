import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import {
  POOL_COOLDOWN_FALLBACK_MS,
  type PoolAttemptResult,
  PoolCooldowns,
  type PoolSite,
} from './pool-cooldowns.store';

const OPUS = { agent: 'claude' as const, model: 'opus' };
const at = (cwd: string, nodeId = 'node'): PoolSite => ({
  cwd,
  runId: 'run',
  nodeId,
});
const FOLDER = at('/work/app');

function failed(patch: Partial<PoolAttemptResult> = {}): PoolAttemptResult {
  return {
    status: 'failed',
    failureClass: 'rate_limited',
    resetsAt: null,
    ...patch,
  };
}

function clocked(
  start: number,
  pinned: (cwd: string) => string | null = () => null,
): { cooldowns: PoolCooldowns; advance: (ms: number) => void } {
  let now = start;
  return {
    cooldowns: new PoolCooldowns(
      (_agent, cwd) => pinned(cwd),
      () => now,
    ),
    advance: (ms) => {
      now += ms;
    },
  };
}

describe('PoolCooldowns', () => {
  it('spends a member until the instant its limit names, then reopens it', () => {
    const { cooldowns, advance } = clocked(Date.parse('2026-10-21T10:00:00Z'));
    cooldowns.record(OPUS, FOLDER, failed({ resetsAt: '3pm (UTC)' }), false);
    advance(4 * 60 * 60 * 1000 + 59 * 60 * 1000);
    expect(cooldowns.standing(OPUS, FOLDER)).toBe('limit');
    advance(2 * 60 * 1000);
    expect(cooldowns.standing(OPUS, FOLDER)).toBeNull();
  });

  it('spends it for the fallback window when the limit names no instant it can place', () => {
    const { cooldowns, advance } = clocked(0);
    cooldowns.record(OPUS, FOLDER, failed({ resetsAt: 'soon' }), false);
    advance(POOL_COOLDOWN_FALLBACK_MS - 1);
    expect(cooldowns.standing(OPUS, FOLDER)).toBe('limit');
    advance(1);
    expect(cooldowns.standing(OPUS, FOLDER)).toBeNull();
  });

  it('reopens a member as soon as it answers', () => {
    const { cooldowns } = clocked(0);
    cooldowns.record(OPUS, FOLDER, failed(), false);
    cooldowns.record(
      OPUS,
      FOLDER,
      { status: 'completed', failureClass: null, resetsAt: null },
      false,
    );
    expect(cooldowns.standing(OPUS, FOLDER)).toBeNull();
  });

  it.each([
    {
      failureClass: 'rate_limited' as const,
      handedPast: false,
      standing: 'limit',
    },
    {
      failureClass: 'auth_expired' as const,
      handedPast: false,
      standing: 'limit',
    },
    {
      failureClass: 'crashed' as const,
      handedPast: true,
      standing: 'unavailable',
    },
    { failureClass: 'crashed' as const, handedPast: false, standing: null },
    {
      failureClass: 'daemon_restart' as const,
      handedPast: true,
      standing: 'unavailable',
    },
  ])(
    '$failureClass, handed past: $handedPast → $standing',
    ({ failureClass, handedPast, standing }) => {
      const { cooldowns } = clocked(0);
      cooldowns.record(OPUS, FOLDER, failed({ failureClass }), handedPast);
      expect(cooldowns.standing(OPUS, FOLDER)).toBe(standing);
    },
  );

  it('keys a limit by CLI, profile and model', () => {
    const { cooldowns } = clocked(0);
    const member = { ...OPUS, configDir: '/profiles/a' };
    cooldowns.record(member, FOLDER, failed(), false);
    expect(cooldowns.standing(member, FOLDER)).toBe('limit');
    expect(
      cooldowns.standing({ ...member, configDir: '/profiles/b' }, FOLDER),
    ).toBeNull();
    expect(cooldowns.standing(OPUS, FOLDER)).toBeNull();
    expect(
      cooldowns.standing({ ...member, model: 'sonnet' }, FOLDER),
    ).toBeNull();
    expect(
      cooldowns.standing({ ...member, agent: 'codex' }, FOLDER),
    ).toBeNull();
  });

  it('keys a member by the account its folder pins, not the profile it names', () => {
    const { cooldowns } = clocked(0, (cwd) =>
      cwd === '/work/pinned' ? '/profiles/pinned' : null,
    );
    cooldowns.record(OPUS, at('/work/pinned'), failed(), false);
    // The same default-profile member in an unpinned folder is another account…
    expect(cooldowns.standing(OPUS, at('/work/other'))).toBeNull();
    // …and a member naming the pinned profile anywhere is the same one.
    expect(
      cooldowns.standing(
        { ...OPUS, configDir: '/profiles/pinned' },
        at('/work/x'),
      ),
    ).toBe('limit');
  });

  it('keeps an ordinary failure to the node that met it, and a limit for everyone', () => {
    const { cooldowns } = clocked(0);
    const crashed = failed({ failureClass: 'crashed' });
    cooldowns.record(OPUS, at('/work/app', 'a'), crashed, true);
    expect(cooldowns.standing(OPUS, at('/work/app', 'a'))).toBe('unavailable');
    expect(cooldowns.standing(OPUS, at('/work/app', 'b'))).toBeNull();
    expect(
      cooldowns.standing(OPUS, { ...at('/work/app', 'a'), runId: 'other' }),
    ).toBeNull();

    cooldowns.record(OPUS, at('/work/app', 'a'), failed(), false);
    expect(cooldowns.standing(OPUS, at('/work/app', 'b'))).toBe('limit');
    // An answer anywhere reopens the account; another node's own mark stays.
    cooldowns.record(OPUS, at('/work/app', 'c'), crashed, true);
    cooldowns.record(
      OPUS,
      at('/work/app', 'b'),
      { status: 'completed', failureClass: null, resetsAt: null },
      false,
    );
    expect(cooldowns.standing(OPUS, at('/work/app', 'a'))).toBe('unavailable');
    expect(cooldowns.standing(OPUS, at('/work/app', 'c'))).toBe('unavailable');
    expect(cooldowns.standing(OPUS, at('/work/app', 'b'))).toBeNull();
  });

  it('reads a profile reached through a symlink as the same account', () => {
    const root = mkdtempSync(join(tmpdir(), 'pool-cooldowns-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const real = mkdtempSync(join(root, 'profile-'));
    const link = join(root, 'link');
    symlinkSync(real, link);
    const { cooldowns } = clocked(0);
    cooldowns.record({ ...OPUS, configDir: link }, FOLDER, failed(), false);
    expect(cooldowns.standing({ ...OPUS, configDir: real }, FOLDER)).toBe(
      'limit',
    );
  });
});
