import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readClaudeSessionPullRequests } from './claude-pr-links.utils';

const SESSION = '9c01226d-baec-4070-a1c8-f349b171381c';

/** A `pr-link` line as claude 2.1.295 writes it. */
function prLink(
  number: number,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'pr-link',
    sessionId: SESSION,
    prNumber: number,
    prUrl: `https://github.com/acme/platform/pull/${number}`,
    prRepository: 'acme/platform',
    timestamp: '2026-10-13T20:36:47.487Z',
    ...overrides,
  });
}

const profiles: string[] = [];

afterEach(() => {
  for (const profile of profiles.splice(0)) {
    if (existsSync(sessionPath(profile))) {
      chmodSync(sessionPath(profile), 0o600);
    }
    rmSync(profile, { recursive: true, force: true });
  }
});

/** A profile holding one session file, under a project directory of its own. */
function profileWith(lines: string[]): string {
  const profile = mkdtempSync(join(tmpdir(), 'claude-pr-links-'));
  profiles.push(profile);
  mkdirSync(projectDir(profile), { recursive: true });
  writeFileSync(sessionPath(profile), `${lines.join('\n')}\n`);
  return profile;
}

function projectDir(profile: string): string {
  return join(profile, 'projects', '-Users-me-acme-platform');
}

function sessionPath(profile: string): string {
  return join(projectDir(profile), `${SESSION}.jsonl`);
}

const numbers = async (profile: string) =>
  (await readClaudeSessionPullRequests(profile, SESSION)).map(
    (row) => row.number,
  );

describe('readClaudeSessionPullRequests', () => {
  it('reads the pull requests the session recorded, oldest first, with when', async () => {
    const profile = profileWith([
      '{"type":"user","message":{"content":"open a PR"}}',
      prLink(6841),
      '{"type":"assistant"}',
      prLink(6841, { timestamp: '2026-10-13T20:37:06.240Z' }),
      prLink(6850, {
        prUrl: 'https://github.com/acme/api/pull/6850',
        prRepository: 'acme/api',
      }),
    ]);

    const found = await readClaudeSessionPullRequests(profile, SESSION);

    expect(found.map((row) => `${row.repo}#${row.number}`)).toEqual([
      'platform#6841',
      'platform#6841',
      'api#6850',
    ]);
    expect(found[0]).toEqual({
      owner: 'acme',
      repo: 'platform',
      number: 6841,
      url: 'https://github.com/acme/platform/pull/6841',
      at: new Date('2026-10-13T20:36:47.487Z'),
    });
  });

  it('skips a record of another session — a fork carries its parent lines', async () => {
    const profile = profileWith([prLink(1, { sessionId: 'parent-session' })]);

    expect(await readClaudeSessionPullRequests(profile, SESSION)).toEqual([]);
  });

  it('skips a host other than github.com and a number that disagrees with the URL', async () => {
    const profile = profileWith([
      prLink(7, {
        prUrl: 'https://gitlab.example.com/acme/app/-/merge_requests/7',
      }),
      prLink(8, { prUrl: 'https://github.com/acme/platform/pull/9' }),
    ]);

    expect(await readClaudeSessionPullRequests(profile, SESSION)).toEqual([]);
  });

  it('reads on past a line that cannot be parsed', async () => {
    const profile = profileWith(['not json "pr-link"', prLink(5)]);

    expect(await numbers(profile)).toEqual([5]);
  });

  it('answers empty for a file it may not read', async () => {
    const profile = profileWith([prLink(5)]);
    chmodSync(sessionPath(profile), 0o000);

    expect(await numbers(profile)).toEqual([]);
  });

  it('does not remember a read that failed, once the file can be read again', async () => {
    const profile = profileWith([prLink(5)]);
    chmodSync(sessionPath(profile), 0o000);
    await numbers(profile);

    chmodSync(sessionPath(profile), 0o600);
    expect(await numbers(profile)).toEqual([5]);
  });

  it('reads a session again once its file changed, and answers from the last read while it has not', async () => {
    const profile = profileWith([prLink(5)]);
    expect(await numbers(profile)).toEqual([5]);

    // A whole second, so restoring it below is exact on any filesystem.
    const at = new Date('2026-10-13T20:00:00.000Z');
    appendFileSync(sessionPath(profile), `${prLink(6)}\n`);
    utimesSync(sessionPath(profile), at, at);
    expect(await numbers(profile)).toEqual([5, 6]);

    // Different content, same size and time: the last read stands.
    writeFileSync(sessionPath(profile), `${prLink(5)}\n${prLink(7)}\n`);
    utimesSync(sessionPath(profile), at, at);
    expect(await numbers(profile)).toEqual([5, 6]);
  });

  it('finds a session again when its file moved, and answers empty once it is gone', async () => {
    const profile = profileWith([prLink(5)]);
    expect(await numbers(profile)).toEqual([5]);

    const moved = join(profile, 'projects', '-Users-me-elsewhere');
    mkdirSync(moved);
    renameSync(sessionPath(profile), join(moved, `${SESSION}.jsonl`));
    appendFileSync(join(moved, `${SESSION}.jsonl`), `${prLink(6)}\n`);
    expect(await numbers(profile)).toEqual([5, 6]);

    rmSync(join(moved, `${SESSION}.jsonl`));
    expect(await numbers(profile)).toEqual([]);
  });

  it('keeps a record whose time cannot be read, without a time', async () => {
    const profile = profileWith([prLink(3, { timestamp: 'later' })]);

    expect(
      (await readClaudeSessionPullRequests(profile, SESSION))[0]?.at,
    ).toBeNull();
  });

  it('answers empty for a session the profile does not hold, or an id that is a path', async () => {
    const profile = profileWith([prLink(3)]);

    expect(
      await readClaudeSessionPullRequests(profile, 'another-session'),
    ).toEqual([]);
    // Would reach the real file through `..` — refused as a path, not an id.
    const escaping = `../-Users-me-acme-platform/${SESSION}`;
    appendFileSync(
      sessionPath(profile),
      `${prLink(4, { sessionId: escaping })}\n`,
    );
    expect(await readClaudeSessionPullRequests(profile, escaping)).toEqual([]);
    expect(
      await readClaudeSessionPullRequests(join(profile, 'missing'), SESSION),
    ).toEqual([]);
  });
});
