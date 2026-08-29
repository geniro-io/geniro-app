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
 * How many pull requests one STATE may contribute.
 *
 * Per state rather than one combined query, and that is a correctness point
 * rather than tidiness: `--limit` is applied before the rows come back and `gh`
 * orders them newest-first, so on a repo whose recent history is all merges a
 * single `--state all` query returns fifty merged pull requests and none of the
 * open ones this panel exists to show.
 *
 * Past the cap the LIST is truncated silently. The branch's own pull request is
 * not lost with it — the head-filtered query below is what guarantees that.
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

/** Newest first. A plain string compare orders gh's UTC RFC-3339 stamps. */
function byNewest(a: PullRequestInfo, b: PullRequestInfo): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

/** One row per pull request — the branch query overlaps the two lists. */
function dedupeByNumber(rows: PullRequestInfo[]): PullRequestInfo[] {
  return [...new Map(rows.map((row) => [row.number, row])).values()];
}

/**
 * Every pull request on the repo `dir` belongs to, plus the branch it has
 * checked out.
 *
 * The branch travels with the list because it is what identifies THIS folder's
 * pull request among them — the app stores no branch on a run, so the pairing is
 * only ever this live read.
 *
 * `gh`'s `closed` covers merged AND closed-unmerged (verified against gh 2.72.0),
 * so the two queries together are the whole history; each row still carries its
 * own state, which is what separates them again on screen.
 */
export async function readPullRequests(
  dir: string,
): Promise<PullRequestsResult> {
  // Resolved once, and BEFORE anything is spawned. On a machine with no `gh`
  // neither query can answer, so reading the branch would be a subprocess per
  // folder on every window focus for a value the failure path throws away.
  const binary = resolveBinary('gh');
  if (binary === null) {
    return NO_PULL_REQUESTS;
  }
  // The local reads first: the branch is what the third query below is FOR.
  const [branch, originOwner] = await Promise.all([
    readHeadBranch(dir),
    readOriginOwner(dir),
  ]);
  const [open, closed, onBranch] = await Promise.all([
    listPullRequests(binary, dir, ['--state', 'open']),
    listPullRequests(binary, dir, ['--state', 'closed']),
    // Exact, and the reason it is worth a third query: the two lists above are
    // a DISPLAY list, where the cap is right, while "which one is this branch's"
    // is a LOOKUP, where a cap is a correctness bound.
    //
    // `branch` is the only argv element in this file that is not a literal, and
    // it stays safe by construction: git's refname rules reject spaces, `..`
    // and control characters, and `--head` is passed as its own token, which
    // gh (Cobra/pflag) consumes as the flag's VALUE whatever it starts with —
    // probe-verified on 2.72.0 with a branch literally named `--json`. Keep it
    // a separate token: `--head=<branch>`, or moving it last, would change that.
    branch === null
      ? Promise.resolve<PullRequestInfo[]>([])
      : listPullRequests(binary, dir, ['--state', 'all', '--head', branch]),
  ]);
  // FAIL CLOSED, rather than keeping whichever query answered. A partial answer
  // does not read as partial: with the open query alone failing, the panel says
  // "Nothing open right now" and the composer names a MERGED pull request as
  // this thread's, both stated with full confidence and neither true.
  if (open === null || closed === null || onBranch === null) {
    return NO_PULL_REQUESTS;
  }
  return {
    branch,
    originOwner,
    pullRequests: dedupeByNumber([...onBranch, ...open, ...closed]).sort(
      byNewest,
    ),
  };
}
