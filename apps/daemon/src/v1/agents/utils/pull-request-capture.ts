import type { RunPullRequest } from '../chat.types';

/**
 * Reading the pull requests a run OPENED out of the transcript it already
 * wrote.
 *
 * **Why the transcript and not the checkout.** The pull-request panel used to
 * answer one question — "what is open on the branch this folder has checked
 * out" — and that key is wrong in both directions. It MISSES: a thread that
 * opened a pull request and then moved the checkout back to `main` shows
 * nothing, and a thread that worked in sibling repositories (`cd ../mobile-app
 * && gh pr create`) was never asked about them at all, because the query only
 * ever knew the run's own `cwd`. It also LIES: a branch the thread never
 * touched carries whatever pull request someone else opened on it, and the
 * panel presented that as this thread's work. Measured on one real thread here
 * — 31 pull requests across 6 repositories, of which the branch query showed
 * ONE, and that one was a merged pull request from earlier, unrelated work.
 *
 * Cursor's Agent Window matches by head branch the same way and carries the
 * same class of bug in its tracker; every product that gets this right —
 * Cursor's cloud agents, Amp's remote threads, Devin — does so because the
 * HARNESS opened the pull request and therefore knows its number by
 * construction. geniro cannot: the model opens it, with the user's own `gh`,
 * in the user's own checkout. The local equivalent of "the harness saw it
 * happen" is this — the URL `gh pr create` printed, in the tool result geniro
 * already persisted.
 *
 * The branch query stays as a SECOND source (see `chats/pull-request.ts`); it
 * is the only thing that can see a pull request the user opened by hand in a
 * browser. What it stops doing is claiming that pull request as the thread's.
 */

/**
 * A pull request URL on github.com.
 *
 * `\d+` is load-bearing rather than merely tidy: `git push` prints
 * `…/pull/new/<branch>` as its "create a pull request" hint, which sits in the
 * SAME tool result as the URL of a pull request that was actually created
 * (verified in the transcripts here). A pattern that accepted a path segment
 * there would file every pushed branch as a pull request that does not exist.
 *
 * github.com only. A GitHub Enterprise host would need its own base URL, and
 * guessing one from an arbitrary `https://…/pull/N` would file a link to
 * someone's blog post as a pull request.
 */
const PULL_REQUEST_URL =
  /https:\/\/github\.com\/([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)\/pull\/(\d+)\b/g;

/**
 * What marks a tool call as OPENING a pull request rather than reading one.
 *
 * Matched against the whole serialized tool input, not a named field: the two
 * shipped transports hand geniro different shapes (claude's `Bash` carries
 * `{command}`, ACP tool calls carry the CLI's own), and this rule must not
 * become a per-CLI branch — `.claude/rules/agent-adapters.md`. The command text
 * is in there under every shape.
 *
 * The distinction is the whole point of the feature: `gh pr view 5161` puts a
 * pull request URL in a tool result too, and it is SOMEBODY ELSE'S. Filing it
 * under this thread is the same mistake as the branch query, arrived at from
 * the other side.
 */
const CREATE_MARKER = 'gh pr create';

/** Whether this tool call is the one that opens a pull request. */
export function isPullRequestCreateCall(input: unknown): boolean {
  try {
    return JSON.stringify(input ?? null)?.includes(CREATE_MARKER) === true;
  } catch {
    // A payload that cannot be serialized (a cycle) is not a shell command.
    return false;
  }
}

/**
 * Every pull request URL in one tool result's text.
 *
 * The result of `gh pr create` is the URL on a line of its own, but it is
 * routinely NOT the only line: a `git push` in the same command prints its
 * `remote:` block first, and `gh` itself prefixes warnings
 * (`Warning: 2 uncommitted changes`). Scanning the whole text rather than
 * parsing the last line is what makes those shapes all work.
 */
export function readPullRequestUrls(
  text: string,
): Omit<RunPullRequest, 'seq'>[] {
  const found: Omit<RunPullRequest, 'seq'>[] = [];
  for (const match of text.matchAll(PULL_REQUEST_URL)) {
    const [url, owner, repo, number] = match;
    // Every group is mandatory in the pattern, so a match has all three. The
    // guard is here because `matchAll` types them optional, and asserting would
    // be the same claim with nothing checking it.
    if (owner === undefined || repo === undefined || number === undefined) {
      continue;
    }
    found.push({ owner, repo, number: Number(number), url });
  }
  return found;
}

/** The identity two captures of the same pull request share. */
export function pullRequestKey(pullRequest: {
  owner: string;
  repo: string;
  number: number;
}): string {
  return `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`;
}

/**
 * How many pull requests one run may carry.
 *
 * Roomy rather than tuned — the thread that motivated this opened 31 — and it
 * is here so a runaway loop cannot grow the run row without bound, not because
 * any real thread approaches it. The OLDEST are kept when it fills: a thread's
 * first pull requests are the ones its later work builds on, and dropping them
 * to make room for a retry storm would lose the thread's own history.
 */
export const MAX_RUN_PULL_REQUESTS = 200;

/**
 * Merge newly captured pull requests into the ones a run already carries.
 *
 * Ordered by the seq they were captured at — the order the thread opened them,
 * which is the order every surface reads them in — and deduplicated by
 * owner/repo/number, keeping the EARLIEST sighting: `gh pr create` prints the
 * URL once, but an agent that later runs `gh pr view` on its own pull request
 * would otherwise move it to the end of the thread's list.
 */
export function mergePullRequests(
  existing: readonly RunPullRequest[],
  captured: readonly RunPullRequest[],
): RunPullRequest[] {
  const byKey = new Map<string, RunPullRequest>();
  for (const pullRequest of [...existing, ...captured]) {
    const key = pullRequestKey(pullRequest);
    const seen = byKey.get(key);
    if (seen === undefined || pullRequest.seq < seen.seq) {
      byKey.set(key, pullRequest);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => a.seq - b.seq)
    .slice(0, MAX_RUN_PULL_REQUESTS);
}

/**
 * The run row's stored JSON, read back as pull requests.
 *
 * Salvages rather than throws: this is a projection every chat route runs
 * through, and one malformed row must cost that run its pull-request list, not
 * the whole chat list. A row written by this daemon is always valid; a row a
 * user edited by hand, or one truncated by a full disk, is the case this is
 * for.
 */
export function readRunPullRequests(
  // `undefined` as well as null: this is a PROJECTION seam, reached with rows
  // built by hand as well as by MikroORM — a fixture that omits the column must
  // read as "no pull requests", not throw inside the chat list.
  raw: string | null | undefined,
): RunPullRequest[] {
  if (raw === null || raw === undefined || raw.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const rows: RunPullRequest[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const row = entry as Record<string, unknown>;
    if (
      typeof row.owner === 'string' &&
      typeof row.repo === 'string' &&
      typeof row.number === 'number' &&
      typeof row.url === 'string' &&
      typeof row.seq === 'number'
    ) {
      rows.push({
        owner: row.owner,
        repo: row.repo,
        number: row.number,
        url: row.url,
        seq: row.seq,
      });
    }
  }
  return rows;
}
