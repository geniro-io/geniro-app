import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parsePullRequests, readPullRequests } from './github-prs';
import { CLAUDE_ONLY_KEYS, CURSOR_ONLY_KEYS } from './probe-env';

/**
 * Driven against a REAL git repository and a REAL `gh` subprocess — a shim
 * script put on `$PATH` — rather than a mocked `execFile`, the doctrine
 * `git-info.spec.ts` states and for the same reason: what is under test is the
 * argv this code sends and what it does with the bytes that come back, and a
 * mock would only replay this file's own assumptions about both.
 *
 * The shim is what makes the happy path testable at all. Driving the real `gh`
 * would need a GitHub repository, an installed binary and a logged-in account,
 * so without it the seam that turns gh's output into the feature's data — the
 * `--json` field list especially, which is coupled to the parser's required-field
 * check — could be deleted with a green suite.
 */
vi.setConfig({ testTimeout: 30_000 });

let dir = '';
let binDir = '';
let argsLog = '';
let openJson = '';
let closedJson = '';
let headJson = '';
let originalPath = '';

const run = (args: string[], cwd = dir): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function initRepo(): void {
  run(['init', '-b', 'main', '-q', dir], tmpdir());
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  run(['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
}

/** One row shaped exactly as `gh pr list --json` emits it. */
function ghRow(
  number: number,
  state: string,
  updatedAt: string,
): Record<string, unknown> {
  return {
    number,
    title: `PR ${number}`,
    state,
    isDraft: false,
    headRefName: `feat/${number}`,
    isCrossRepository: false,
    headRepositoryOwner: { id: 'o', login: 'acme' },
    author: { id: 'x', is_bot: false, login: 'someone', name: 'Some One' },
    url: `https://github.com/o/r/pull/${number}`,
    updatedAt,
  };
}

/**
 * Put a fake `gh` in front of whatever this machine has.
 *
 * PREPENDED, never replacing `$PATH`: `git` has to keep resolving for the branch
 * read. Prepending is also what makes the shim win on a machine that HAS a real
 * `gh` — `resolveBinary` walks `$PATH` before the well-known install dirs, so a
 * Homebrew `gh` would otherwise answer instead.
 */
function installGhShim(body: string): void {
  writeFileSync(join(binDir, 'gh'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  process.env.PATH = `${binDir}:${originalPath}`;
}

/** A shim answering both states from the fixture files, logging its argv. */
const RECORDING_SHIM = `printf '%s\\n' "$*" >> "ARGS_LOG"
case "$*" in
  *"--head"*) cat "HEAD_JSON" ;;
  *"--state open"*) cat "OPEN_JSON" ;;
  *) cat "CLOSED_JSON" ;;
esac`;

function recordingShim(): string {
  return RECORDING_SHIM.replace('ARGS_LOG', argsLog)
    .replace('HEAD_JSON', headJson)
    .replace('OPEN_JSON', openJson)
    .replace('CLOSED_JSON', closedJson);
}

const ghCalls = (): string[] =>
  readFileSync(argsLog, 'utf8').trim().split('\n').filter(Boolean);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'geniro-gh-'));
  binDir = mkdtempSync(join(tmpdir(), 'geniro-bin-'));
  argsLog = join(binDir, 'args.log');
  openJson = join(binDir, 'open.json');
  closedJson = join(binDir, 'closed.json');
  headJson = join(binDir, 'head.json');
  writeFileSync(argsLog, '');
  writeFileSync(openJson, '[]');
  writeFileSync(closedJson, '[]');
  writeFileSync(headJson, '[]');
  originalPath = process.env.PATH ?? '';
});

afterEach(() => {
  // In the hook, not at the end of the one test that stubs: a failing assertion
  // would otherwise leave fake credentials in `process.env` for every case after
  // it, turning one red test into a confusing cascade.
  vi.unstubAllEnvs();
  process.env.PATH = originalPath;
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

describe('readPullRequests', () => {
  it('asks gh for BOTH states and merges them newest-first', async () => {
    // The two queries are a correctness point, not tidiness: `--limit` is applied
    // before the rows come back and gh orders newest-first, so one `--state all`
    // query on a repo whose recent history is all merges returns no open pull
    // requests at all. Reverting to a single call fails this case.
    initRepo();
    writeFileSync(
      openJson,
      JSON.stringify([ghRow(71, 'OPEN', '2026-08-20T00:00:00Z')]),
    );
    writeFileSync(
      closedJson,
      JSON.stringify([
        ghRow(70, 'MERGED', '2026-08-25T00:00:00Z'),
        ghRow(69, 'CLOSED', '2026-08-10T00:00:00Z'),
      ]),
    );
    installGhShim(recordingShim());

    const result = await readPullRequests(dir);

    expect(result.branch).toBe('main');
    expect(result.originOwner).toBe('acme');
    expect(result.pullRequests.map((entry) => entry.number)).toEqual([
      70, 71, 69,
    ]);
    expect(result.pullRequests.map((entry) => entry.state)).toEqual([
      'merged',
      'open',
      'closed',
    ]);

    const calls = ghCalls();
    expect(calls.some((call) => call.includes('--state open'))).toBe(true);
    expect(calls.some((call) => call.includes('--state closed'))).toBe(true);
  });

  it('asks for exactly the fields the parser requires', async () => {
    // The field list and `readPullRequestRow`'s required-field check are one
    // contract: drop or rename a field here and EVERY row is dropped, so all
    // three surfaces silently render nothing with no test moving.
    initRepo();
    installGhShim(recordingShim());

    await readPullRequests(dir);

    for (const call of ghCalls()) {
      expect(call).toContain(
        '--json number,title,state,isDraft,headRefName,isCrossRepository,headRepositoryOwner,author,url,updatedAt',
      );
      expect(call).toContain('--limit 50');
    }
  });

  it('finds this branch’s pull request even when the capped lists missed it', async () => {
    // The two lists are a DISPLAY list, where a cap is right; "which one is this
    // branch's" is a lookup, where a cap is a correctness BOUND. Here neither
    // list carries it and only the exact `--head` query does — which is what a
    // repo with more than fifty open pull requests looks like.
    initRepo();
    writeFileSync(
      headJson,
      JSON.stringify([ghRow(999, 'OPEN', '2026-01-01T00:00:00Z')]),
    );
    installGhShim(recordingShim());

    const result = await readPullRequests(dir);

    expect(result.pullRequests.map((entry) => entry.number)).toEqual([999]);
    // The whole selector, not just the flag: narrowed to `--state open` this
    // query would stop finding a merged or closed branch pull request past the
    // cap, which is most of what it is for.
    expect(
      ghCalls().some((call) => call.includes('--state all --head main')),
    ).toBe(true);
  });

  it('lists a pull request once when the branch query overlaps a list', async () => {
    initRepo();
    const both = ghRow(71, 'OPEN', '2026-08-20T00:00:00Z');
    writeFileSync(openJson, JSON.stringify([both]));
    writeFileSync(headJson, JSON.stringify([both]));
    installGhShim(recordingShim());

    const result = await readPullRequests(dir);

    expect(result.pullRequests.map((entry) => entry.number)).toEqual([71]);
  });

  it('names no branch on a detached HEAD, and still lists the pull requests', async () => {
    // "Current PR" is defined by this branch, so the detached mapping is what
    // decides whether a thread claims a pull request that is not its own.
    initRepo();
    run(['checkout', '-q', '--detach']);
    writeFileSync(
      openJson,
      JSON.stringify([ghRow(71, 'OPEN', '2026-08-20T00:00:00Z')]),
    );
    installGhShim(recordingShim());

    const result = await readPullRequests(dir);

    expect(result.branch).toBeNull();
    expect(result.pullRequests).toHaveLength(1);
    // And no branch query is even attempted: there is no branch to ask about.
    expect(ghCalls().some((call) => call.includes('--head'))).toBe(false);
  });

  it('answers empty when gh cannot answer', async () => {
    // One outcome for every failure by design — no `gh`, a logged-out `gh`, a
    // folder that is not a GitHub checkout — so every surface draws nothing
    // rather than an error strip.
    initRepo();
    installGhShim('exit 1');

    expect(await readPullRequests(dir)).toEqual({
      branch: null,
      originOwner: null,
      pullRequests: [],
    });
  });

  it('FAILS CLOSED when only one of the three queries fails', async () => {
    // Keeping the half that answered reads as a confident wrong answer rather
    // than a partial one: with the OPEN query alone failing, the panel would say
    // "Nothing open right now" and the composer would name a merged pull request
    // as this thread's — both stated plainly, neither true.
    initRepo();
    writeFileSync(
      closedJson,
      JSON.stringify([ghRow(70, 'MERGED', '2026-08-25T00:00:00Z')]),
    );
    installGhShim(`case "$*" in
  *"--head"*) cat "${headJson}" ;;
  *"--state open"*) exit 1 ;;
  *) cat "${closedJson}" ;;
esac`);

    expect(await readPullRequests(dir)).toEqual({
      branch: null,
      originOwner: null,
      pullRequests: [],
    });
  });

  it('FAILS CLOSED when the BRANCH query is the one that fails', async () => {
    // The third query's own failure arm, which nothing else enters. Dropping
    // that clause — or writing `onBranch ?? []` — would let a blip on the
    // LOOKUP quietly downgrade to "this branch has no pull request" while both
    // display lists answered perfectly well.
    initRepo();
    writeFileSync(
      openJson,
      JSON.stringify([ghRow(71, 'OPEN', '2026-08-20T00:00:00Z')]),
    );
    installGhShim(`case "$*" in
  *"--head"*) exit 1 ;;
  *"--state open"*) cat "${openJson}" ;;
  *) cat "${closedJson}" ;;
esac`);

    expect(await readPullRequests(dir)).toEqual({
      branch: null,
      originOwner: null,
      pullRequests: [],
    });
  });

  it('hands gh NONE of the agent CLIs’ credentials', async () => {
    // `gh pr list` is an authenticated network call, so by the rule
    // `probe-env.ts` states for the two agent CLIs it is exactly the child that
    // must not be carrying either one's token — and `gh` owns none of them.
    // Looped over the exported lists rather than a hand-picked pair, so the pin
    // grows with them.
    initRepo();
    for (const key of [...CLAUDE_ONLY_KEYS, ...CURSOR_ONLY_KEYS]) {
      vi.stubEnv(key, `secret-value-of-${key}`);
    }
    const envDump = join(binDir, 'env.dump');
    installGhShim(`env > "${envDump}"`);

    await readPullRequests(dir);

    const childEnv = readFileSync(envDump, 'utf8');
    for (const key of [...CLAUDE_ONLY_KEYS, ...CURSOR_ONLY_KEYS]) {
      expect(childEnv).not.toContain(`secret-value-of-${key}`);
    }
    // A control, so the assertion above cannot pass merely because the child
    // received no environment at all.
    expect(childEnv).toContain('PATH=');
  });
});

describe('parsePullRequests', () => {
  const row = (
    number: number,
    state: string,
    updatedAt = '2026-08-01T00:00:00Z',
  ): Record<string, unknown> => ghRow(number, state, updatedAt);

  it('maps gh’s own state enum and flattens the author to its login', () => {
    const parsed = parsePullRequests(
      JSON.stringify([row(1, 'OPEN'), row(2, 'MERGED'), row(3, 'CLOSED')]),
    );

    expect(parsed?.map((entry) => entry.state)).toEqual([
      'open',
      'merged',
      'closed',
    ]);
    expect(parsed?.[0]?.author).toBe('someone');
  });

  it('drops a malformed row and keeps the rest', () => {
    const parsed = parsePullRequests(
      JSON.stringify([
        row(1, 'OPEN'),
        { number: 2, title: 'every other field missing' },
        row(3, 'OPEN'),
      ]),
    );

    // One unrecognised entry costs that entry, never the whole section.
    expect(parsed?.map((entry) => entry.number)).toEqual([1, 3]);
  });

  it('drops a state outside gh’s enum rather than relabelling it', () => {
    // Relabelling would file a pull request under the wrong heading, and the
    // heading is the entire reading of the section.
    expect(
      parsePullRequests(JSON.stringify([row(1, 'SOMETHING_NEW')])),
    ).toEqual([]);
  });

  it('drops a row whose state collides with an Object.prototype member', () => {
    // A bare object literal inherits `constructor` and `toString`, so a plain
    // index would resolve those to a FUNCTION that passes an `undefined` check
    // and then fails structured clone on its way across IPC.
    expect(parsePullRequests(JSON.stringify([row(1, 'constructor')]))).toEqual(
      [],
    );
    expect(parsePullRequests(JSON.stringify([row(1, 'toString')]))).toEqual([]);
  });

  it('drops a row carrying no isCrossRepository rather than defaulting it', () => {
    // The fork exclusion downstream reads `!isCrossRepository`, so an absent
    // field would read as "not a fork" and every fork pull request would become
    // matchable again — the exact defect the exclusion exists for. This is the
    // runtime link between the `--json` field list and that consumer.
    const withoutField: Record<string, unknown> = { ...row(1, 'OPEN') };
    delete withoutField.isCrossRepository;

    expect(parsePullRequests(JSON.stringify([withoutField]))).toEqual([]);
  });

  it('KEEPS a row whose head repository is gone', () => {
    // GitHub's own schema makes `headRepositoryOwner` nullable, and a deleted
    // fork is the routine way it happens. Requiring it would drop that pull
    // request from the panel entirely rather than merely leaving it unmatchable
    // as this thread's — which is the twin of the case above, decided the other
    // way on purpose.
    const deletedFork = { ...row(1, 'OPEN'), headRepositoryOwner: null };

    expect(parsePullRequests(JSON.stringify([deletedFork]))).toEqual([
      expect.objectContaining({ number: 1, headRepositoryOwner: null }),
    ]);
  });

  it('drops a row whose url is not https', () => {
    // The one field that becomes an `href`. Checked here rather than trusted to
    // the renderer's CSP and main's window-open handler alone.
    const hostile = { ...row(1, 'OPEN'), url: 'javascript:alert(1)' };

    expect(parsePullRequests(JSON.stringify([hostile]))).toEqual([]);
  });

  it('answers null for output that is not a JSON array', () => {
    expect(parsePullRequests('not json at all')).toBeNull();
    expect(parsePullRequests('{"pullRequests":[]}')).toBeNull();
  });
});
