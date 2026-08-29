import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  PullRequestInfo,
  PullRequestsResult,
  PullRequestState,
} from '../shared/contracts';
import { readHeadBranch, readOriginOwner } from './git-info';
import { neutralEnv } from './probe-env';
import { resolveBinary } from './resolve-binary';

const execFileAsync = promisify(execFile);

/** A `gh` call is a round trip to GitHub, not a local ref read. */
const GH_TIMEOUT_MS = 15_000;

/**
 * How many pull requests one branch may contribute.
 *
 * Roomy rather than tuned: the query is head-filtered, so this bounds how often
 * ONE branch name has been used for a pull request, which is a handful even on a
 * long-lived `main`. It is here so a pathological repo cannot hand the renderer
 * an unbounded list, not because any real branch approaches it.
 */
const PULL_REQUEST_LIMIT = 50;

/** The fields {@link readPullRequestRow} requires; a row missing any is dropped. */
const PULL_REQUEST_FIELDS =
  'number,title,state,isDraft,headRefName,isCrossRepository,headRepositoryOwner,author,url,updatedAt';

const NO_PULL_REQUESTS: PullRequestsResult = {
  branch: null,
  originOwner: null,
  pullRequests: [],
};

/**
 * Run one `gh` command in `cwd`. Never throws, on the same rule the git helpers
 * follow: an absent binary, a logged-out CLI and a folder with no GitHub remote
 * are all "no answer" to a caller that only decides whether to draw a section.
 */
async function gh(
  binary: string,
  cwd: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, args, {
      cwd,
      timeout: GH_TIMEOUT_MS,
      // A repo with hundreds of pull requests must not blow up the IPC payload.
      maxBuffer: 1024 * 1024,
      env: neutralEnv(),
    });
    return stdout;
  } catch {
    return null;
  }
}

/** gh's own `PullRequestState` enum, which has exactly these three members. */
const PULL_REQUEST_STATES: Record<string, PullRequestState> = {
  OPEN: 'open',
  MERGED: 'merged',
  CLOSED: 'closed',
};

function loginOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>).login
    : undefined;
}

function readPullRequestRow(entry: unknown): PullRequestInfo | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const row = entry as Record<string, unknown>;
  // `hasOwn` before the index: a bare object literal inherits `constructor` and
  // `toString`, so those two keys would otherwise resolve to a function that
  // passes the `undefined` check below and then fails structured clone on its
  // way across IPC.
  const state =
    typeof row.state === 'string' &&
    Object.hasOwn(PULL_REQUEST_STATES, row.state)
      ? PULL_REQUEST_STATES[row.state]
      : undefined;
  // gh nests both logins one level down; the rest of the app only ever wants
  // the names, so they are flattened at the one place that knows the shape.
  const author = loginOf(row.author);
  const headRepositoryOwner = loginOf(row.headRepositoryOwner);
  if (
    typeof row.number !== 'number' ||
    typeof row.title !== 'string' ||
    state === undefined ||
    typeof row.isDraft !== 'boolean' ||
    typeof row.headRefName !== 'string' ||
    typeof row.isCrossRepository !== 'boolean' ||
    // Checked as a URL and not merely as a string: this is the one field that
    // becomes an `href`, and the renderer should never be handed a scheme it
    // would refuse anyway.
    typeof row.url !== 'string' ||
    !row.url.startsWith('https://') ||
    typeof row.updatedAt !== 'string' ||
    typeof author !== 'string' ||
    // NOT required, unlike every other field: GitHub's schema makes the head
    // repository nullable, and a deleted fork is the routine way it happens.
    // Requiring it would drop such a pull request from the panel entirely
    // instead of merely leaving it unmatchable as "this thread's".
    (headRepositoryOwner !== undefined &&
      typeof headRepositoryOwner !== 'string')
  ) {
    return null;
  }
  return {
    number: row.number,
    title: row.title,
    state,
    isDraft: row.isDraft,
    headRefName: row.headRefName,
    isCrossRepository: row.isCrossRepository,
    headRepositoryOwner: headRepositoryOwner ?? null,
    author,
    url: row.url,
    updatedAt: row.updatedAt,
  };
}

/**
 * Read gh's `--json` array into the wire shape.
 *
 * Separated from the call that produces it so the mapping can be entered by a
 * test without a GitHub repo, an installed `gh` and a logged-in account.
 *
 * A row that does not parse is DROPPED rather than failing the batch — one
 * unrecognised entry should cost that entry and not the whole section — and a
 * state outside gh's enum is one such row rather than being relabelled as
 * something it might not be.
 */
export function parsePullRequests(stdout: string): PullRequestInfo[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const rows: PullRequestInfo[] = [];
  for (const entry of parsed) {
    const row = readPullRequestRow(entry);
    if (row !== null) {
      rows.push(row);
    }
  }
  return rows;
}

async function listPullRequests(
  binary: string,
  dir: string,
  selector: string[],
): Promise<PullRequestInfo[] | null> {
  const stdout = await gh(binary, dir, [
    'pr',
    'list',
    ...selector,
    '--limit',
    String(PULL_REQUEST_LIMIT),
    '--json',
    PULL_REQUEST_FIELDS,
  ]);
  return stdout === null ? null : parsePullRequests(stdout);
}

/**
 * Newest first — the order every surface reads in, and what
 * `chats/pull-request.ts` picks the thread's CURRENT pull request from when
 * none on the branch is open. Sorted here rather than trusted from `gh`, since
 * that is a contract of {@link PullRequestsResult} and not of the CLI.
 *
 * A plain string compare orders gh's UTC RFC-3339 stamps.
 */
function byNewest(a: PullRequestInfo, b: PullRequestInfo): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * The pull requests on the branch `dir` has checked out, plus the branch itself.
 *
 * Head-filtered at the QUERY, not in the renderer: a thread is one folder on one
 * branch, and everything the app draws about pull requests is scoped to that
 * (`chats/pull-request.ts`). Asking for the repo's whole list was the first
 * shape and cost three round trips to fetch fifty rows that were then filtered
 * down to one — and, because a cap has to be applied somewhere, needed a
 * separate head query underneath it anyway to guarantee the branch's own pull
 * request survived the truncation. One exact question replaces all of it.
 *
 * `--state all` because a branch's history is the point: an open pull request
 * and the merged one it replaced belong under the same thread. gh's own three
 * states then separate them again on screen.
 *
 * The branch travels with the list because it is what identifies these as THIS
 * folder's — the app stores no branch on a run, so the pairing is only ever
 * this live read. `originOwner` rides along for the fork case; the filtering
 * itself stays in the renderer, which is where a stranger's same-named fork
 * branch is told from the user's own (`isOurHead`).
 */
export async function readPullRequests(
  dir: string,
): Promise<PullRequestsResult> {
  // Resolved once, and BEFORE anything is spawned. On a machine with no `gh`
  // the query cannot answer, so reading the branch would be a subprocess per
  // folder on every window focus for a value the failure path throws away.
  const binary = resolveBinary('gh');
  if (binary === null) {
    return NO_PULL_REQUESTS;
  }
  // Read first and awaited alone, because it is the query's own argument.
  const branch = await readHeadBranch(dir);
  if (branch === null) {
    // A detached HEAD is on no branch, so there is nothing to ask about — and
    // no surface would draw the answer either way.
    return NO_PULL_REQUESTS;
  }
  const [originOwner, onBranch] = await Promise.all([
    readOriginOwner(dir),
    // `branch` is the only argv element in this file that is not a literal, and
    // it stays safe by construction: git's refname rules reject spaces, `..`
    // and control characters, and `--head` is passed as its own token, which
    // gh (Cobra/pflag) consumes as the flag's VALUE whatever it starts with —
    // probe-verified on 2.72.0 with a branch literally named `--json`. Keep it
    // a separate token: `--head=<branch>`, or moving it last, would change that.
    listPullRequests(binary, dir, ['--state', 'all', '--head', branch]),
  ]);
  if (onBranch === null) {
    return NO_PULL_REQUESTS;
  }
  return { branch, originOwner, pullRequests: [...onBranch].sort(byNewest) };
}
