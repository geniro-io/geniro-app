import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

import type {
  PullRequestInfo,
  PullRequestRef,
  PullRequestRefResult,
  PullRequestState,
} from '../shared/contracts';
import { neutralEnv } from './probe-env';
import { resolveBinary } from './resolve-binary';

const execFileAsync = promisify(execFile);

/** A `gh` call is a round trip to GitHub, not a local ref read. */
const GH_TIMEOUT_MS = 15_000;

/**
 * The GraphQL selection {@link readPullRequestRow} reads. A row missing any of
 * the REQUIRED fields is dropped; the three diff figures, `mergedAt`,
 * `baseRefName` and `headRefOid` are optional and their absence costs those
 * fields alone.
 *
 * The names are gh's own `--json` names, which are GitHub's GraphQL field
 * names, so the row reader is the same for both.
 */
const PULL_REQUEST_SELECTION =
  'number title state isDraft headRefName headRefOid baseRefName isCrossRepository headRepositoryOwner { login } author { login } url updatedAt mergedAt additions deletions changedFiles';

/**
 * How many pull requests one GraphQL query asks about, by alias. GitHub counts
 * a pull request's figures on first ask, which measured past
 * {@link GH_TIMEOUT_MS} for 24 old ones at once, and a timed-out query costs
 * every pull request in it.
 */
const PULL_REQUESTS_PER_QUERY = 10;

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
      maxBuffer: 1024 * 1024,
      env: neutralEnv(),
    });
    return stdout;
  } catch (err) {
    // `gh api graphql` exits 1 when one alias fails (a deleted pull request)
    // and still prints the data it has for the others.
    const stdout = (err as { stdout?: unknown }).stdout;
    return typeof stdout === 'string' && stdout.length > 0 ? stdout : null;
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
  const mergedAt =
    state === 'merged' ? timeOrUndefined(row.mergedAt) : undefined;
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
    // OPTIONAL, and only ever on a MERGED row: an open one has no merge time,
    // whatever gh put in the field. Left out rather than set to undefined, so
    // the key's absence is the whole of "no merge time".
    ...(mergedAt === undefined ? {} : { mergedAt }),
    // OPTIONAL, unlike everything above: a row that does not carry them is a
    // pull request without its size, never a row to drop. gh omits them on an
    // older version, so requiring them would make one gh upgrade the difference
    // between a populated panel and an empty one.
    added: numberOrNull(row.additions),
    removed: numberOrNull(row.deletions),
    changedFiles: numberOrNull(row.changedFiles),
    ...(typeof row.baseRefName === 'string'
      ? { baseRefName: row.baseRefName }
      : {}),
    ...(typeof row.headRefOid === 'string'
      ? { headRefOid: row.headRefOid }
      : {}),
  };
}

/** A figure gh reported, or null — never a zero standing in for silence. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A time gh reported that a `Date` can read, or undefined. */
function timeOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

/**
 * Read a `gh api graphql` answer about one repository's pull requests into the
 * wire shape: every alias under `data.repository` is one pull request.
 *
 * A row that does not parse is DROPPED rather than failing the batch, and an
 * alias GitHub could not resolve (null) is one such row. A state outside gh's
 * enum is dropped too rather than being relabelled as something it might not
 * be. Null when the answer carries no repository at all.
 */
export function parsePullRequests(stdout: string): PullRequestInfo[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const repository = (
    (parsed as { data?: { repository?: unknown } } | null)?.data ?? null
  )?.repository;
  if (
    typeof repository !== 'object' ||
    repository === null ||
    Array.isArray(repository)
  ) {
    return null;
  }
  const rows: PullRequestInfo[] = [];
  for (const entry of Object.values(repository)) {
    const row = readPullRequestRow(entry);
    if (row !== null) {
      rows.push(row);
    }
  }
  return rows;
}

function pullRequestsQuery(numbers: readonly number[]): string {
  const aliases = numbers
    .map(
      (number) =>
        `p${number}: pullRequest(number: ${number}) { ${PULL_REQUEST_SELECTION} }`,
    )
    .join(' ');
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases} } }`;
}

/** Exactly the pull requests asked about, one GraphQL round trip per batch. */
async function readRepositoryPullRequests(
  binary: string,
  dir: string,
  owner: string,
  name: string,
  numbers: readonly number[],
): Promise<PullRequestInfo[]> {
  const rows: PullRequestInfo[] = [];
  for (let at = 0; at < numbers.length; at += PULL_REQUESTS_PER_QUERY) {
    const stdout = await gh(binary, dir, [
      'api',
      'graphql',
      '-f',
      `query=${pullRequestsQuery(numbers.slice(at, at + PULL_REQUESTS_PER_QUERY))}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
    ]);
    rows.push(...((stdout === null ? null : parsePullRequests(stdout)) ?? []));
  }
  return rows;
}

/**
 * How many distinct REPOSITORIES one resolve may ask about.
 *
 * Each is a round trip to GitHub, so the bound is on repositories rather than
 * on pull requests: thirty-one pull requests across six repositories cost six
 * queries.
 */
const REF_REPO_LIMIT = 24;

/**
 * Live state for pull requests a THREAD opened, addressed by URL rather than by
 * branch.
 *
 * This is the other half of `apps/daemon/.../pull-request-capture.ts`: the
 * daemon knows WHICH pull requests belong to a thread (it read them out of the
 * agent's own output), and only GitHub knows what they currently are. Keeping
 * the two apart is deliberate — a title and a state stored at capture time
 * would be a stale second answer beside this one.
 *
 * Addressing by owner, repository and number is what makes a MULTI-REPOSITORY
 * thread work at all: nothing here has to know where the agent was standing
 * when it ran `gh pr create` — which is unknowable in the general case, since
 * the agent `cd`s inside its own shell commands.
 *
 * Each repository is ONE query naming exactly the pull requests asked about,
 * so a pull request is answered however old it is and however many other
 * threads on screen share its repository.
 *
 * Runs from the user's HOME rather than any checkout: no folder here is the
 * right one, and the query names the repository itself.
 *
 * Never throws, on the rule the whole file follows: an absent binary, a
 * logged-out CLI and a repository this account cannot see are all "no answer"
 * about that pull request. The REF still comes back — the thread did open it,
 * and a row that links to it while saying nothing about its state is better
 * than a row that vanishes.
 */
export async function readPullRequestsByRef(
  refs: readonly PullRequestRef[],
): Promise<PullRequestRefResult[]> {
  const unresolved = refs.map((ref) => ({ ref, pullRequest: null }));
  const binary = resolveBinary('gh');
  if (binary === null || refs.length === 0) {
    return unresolved;
  }
  const dir = homedir();
  const byRepo = new Map<
    string,
    { owner: string; name: string; numbers: Set<number> }
  >();
  for (const ref of refs) {
    if (!Number.isSafeInteger(ref.number) || ref.number <= 0) {
      continue;
    }
    const key = `${ref.owner}/${ref.repo}`;
    const group = byRepo.get(key);
    if (group === undefined) {
      if (byRepo.size >= REF_REPO_LIMIT) {
        continue;
      }
      byRepo.set(key, {
        owner: ref.owner,
        name: ref.repo,
        numbers: new Set([ref.number]),
      });
      continue;
    }
    group.numbers.add(ref.number);
  }

  const found = new Map<string, PullRequestInfo>();
  // SEQUENTIAL: each iteration is a process talking to GitHub, and a thread spanning six
  // repositories would otherwise open six at once on the first paint.
  for (const [repo, group] of byRepo) {
    const rows = await readRepositoryPullRequests(
      binary,
      dir,
      group.owner,
      group.name,
      [...group.numbers],
    );
    for (const row of rows) {
      found.set(`${repo}#${row.number}`, row);
    }
  }

  return refs.map((ref) => ({
    ref,
    pullRequest: found.get(`${ref.owner}/${ref.repo}#${ref.number}`) ?? null,
  }));
}
