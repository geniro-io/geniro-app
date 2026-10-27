import type { ItemKind } from '../../runs/runs.types';
import type {
  DisplayedPullRequest,
  PullRequestOutcome,
  RunPullRequest,
} from '../chat.types';

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
 * A pull request URL on github.com that ENDS its line — alone, or after
 * whitespace or `=`.
 *
 * `\d+` is load-bearing rather than merely tidy: `git push` prints
 * `…/pull/new/<branch>` as its "create a pull request" hint, which sits in the
 * SAME tool result as the URL of a pull request that was actually created
 * (verified in the transcripts here). A pattern that accepted a path segment
 * there would file every pushed branch as a pull request that does not exist.
 *
 * `gh pr create` prints the URL on a line of its own, but an agent that keeps
 * that stdout in a variable prints it after a label of its own
 * (`create rc=0 url=<URL>`, `PR: <URL>`, a table whose last column is the URL),
 * so the URL has to END the line rather than BE it. Not after a bare `:` —
 * that is `grep -n`'s `12:<URL>`. A URL in the middle of a line stays a
 * quotation — `Opened <URL> for review.`, or a `grep` over an
 * exported transcript answering `…draft PR is up — <URL>\n\n**PR…` — and only a
 * result of a call that RUNS `gh pr create` is read at all
 * ({@link runsPullRequestCreate}).
 *
 * github.com only. A GitHub Enterprise host would need its own base URL, and
 * guessing one from an arbitrary `https://…/pull/N` would file a link to
 * someone's blog post as a pull request.
 */
const PULL_REQUEST_URL_LINE =
  /(?:^|[\s=])(https:\/\/github\.com\/([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)\/pull\/(\d+))$/;

/**
 * What marks a tool call as OPENING a pull request rather than reading one.
 *
 * Matched against every string the tool input carries, not a named field: the
 * two shipped transports hand geniro different shapes (claude's `Bash` carries
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

/**
 * The characters after which a shell reads the next word as a COMMAND: a
 * separator, a pipe, a subshell or group opening, a new line.
 */
const COMMAND_OPENERS = new Set([';', '&', '|', '(', '{', '\n']);

/**
 * Words that may stand IN FRONT of a command in the same simple command
 * without being the command: a compound keyword that opens a body (`then`,
 * `do`), negation, and the wrappers that run their argument (`time`, `env`,
 * `nohup`, `timeout 60`, `xargs -I{}`). Under a rule that knew none of them, a
 * loop over repositories (`for r in …; do gh pr create …`) would open real pull
 * requests that no chip ever showed.
 */
const COMMAND_PREFIX_WORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
  'time',
  'env',
  'command',
  'exec',
  'nohup',
  'timeout',
  'xargs',
  'sudo',
  'nice',
]);

/** A variable assignment in front of a command — `GH_REPO=o/r gh pr create`. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** An option or a count a prefix command takes before its own — `-I{}`, `60`. */
const PREFIX_ARGUMENT = /^(?:-\S*|\d+(?:\.\d+)?[smhd]?)$/;

/**
 * A shell run with `-c` (or `-lc`, `-ec`…), whose quoted argument is a script
 * of its own — the one place a command legitimately begins right after a
 * quote. Named shells only: `grep -c 'gh pr create'` also ends in `-c`, and
 * COUNTS the words rather than running them.
 */
const SHELL_WRAPPER = /(?:^|[\s/])(?:sh|bash|zsh|dash|ksh)\s+-[A-Za-z]*c$/;

/**
 * Whether `text` RUNS `gh pr create`, as opposed to containing those words.
 *
 * The marker used to be matched anywhere in the input, and that filed a pull
 * request under the wrong thread on this app's own conversation: a sub-agent
 * reading an exported transcript ran `grep -n 'gh pr create\|pull/5639' file`
 * — the words as a search PATTERN — and the grep's output quoted the URL that
 * transcript's own thread had opened. So the marker has to stand where a shell
 * would execute it: at the start of the text, after a separator, inside a
 * shell wrapper's `-c` argument, after the `--` that ends a wrapper's options,
 * or behind words that only lead up to a command — assignments, `then`/`do`,
 * `time`/`env`/`timeout 60` — with `gh` named bare or by its path. Inside a
 * quoted pattern, after an `echo`, in a sentence of prose or in a backticked
 * span of markdown, it is being talked about.
 */
export function runsPullRequestCreate(text: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(CREATE_MARKER, from);
    if (at === -1) {
      return false;
    }
    from = at + CREATE_MARKER.length;
    const after = text[from];
    // `gh pr created` is not the command either.
    if (after !== undefined && !/\s/.test(after)) {
      continue;
    }
    if (atCommandPosition(text, at)) {
      return true;
    }
  }
}

/** Where one shell word ends, reading either way. */
function isWordBoundary(char: string): boolean {
  return (
    char === ' ' ||
    char === '\t' ||
    char === '"' ||
    char === "'" ||
    char === '`' ||
    COMMAND_OPENERS.has(char)
  );
}

/** Whether a word beginning at `at` is where a shell would read a command. */
function atCommandPosition(text: string, at: number): boolean {
  let i = at - 1;
  if (text[i] === '/') {
    // `/opt/homebrew/bin/gh pr create`: the binary named by its path is still
    // the binary, so the word to judge from starts where the path does.
    while (i >= 0 && !isWordBoundary(text[i]!)) {
      i -= 1;
    }
  } else if (i >= 0 && !isWordBoundary(text[i]!)) {
    // `mygh pr create`: the marker begins inside some other word.
    return false;
  }
  for (;;) {
    while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) {
      i -= 1;
    }
    if (i < 0) {
      return true;
    }
    const before = text[i]!;
    if (COMMAND_OPENERS.has(before)) {
      return true;
    }
    if (before === '`') {
      // `URL=`gh pr create`` substitutes the command; a backticked span of
      // markdown prose has a space in front of it instead.
      return text[i - 1] === '=';
    }
    if (before === '"' || before === "'") {
      return SHELL_WRAPPER.test(text.slice(0, i).trimEnd());
    }
    // A brace opens a group only as a word of its own (`{ gh pr create; }`,
    // answered above); inside a word it is that word's own text — `-I{}`.
    let start = i;
    while (
      start > 0 &&
      (text[start - 1] === '{' || !isWordBoundary(text[start - 1]!))
    ) {
      start -= 1;
    }
    const word = text.slice(start, i + 1);
    // `zsh … -- gh pr create`: the end of a wrapper's own options, after which
    // the command it was handed begins.
    if (word === '--') {
      return true;
    }
    if (
      !ASSIGNMENT_WORD.test(word) &&
      !COMMAND_PREFIX_WORDS.has(word) &&
      !PREFIX_ARGUMENT.test(word)
    ) {
      return false;
    }
    i = start - 1;
  }
}

/** How deep a tool input is walked for its strings — a cycle bounds itself. */
const MAX_INPUT_DEPTH = 8;

/** Every string a tool input carries, whatever shape the CLI gave it. */
function* stringsOf(value: unknown, depth = 0): Generator<string> {
  if (typeof value === 'string') {
    yield value;
    return;
  }
  if (depth >= MAX_INPUT_DEPTH || value === null || typeof value !== 'object') {
    return;
  }
  const inner = Array.isArray(value) ? value : Object.values(value);
  for (const entry of inner) {
    yield* stringsOf(entry, depth + 1);
  }
}

/** Whether this tool call is the one that opens a pull request. */
export function isPullRequestCreateCall(input: unknown): boolean {
  for (const text of stringsOf(input)) {
    if (runsPullRequestCreate(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Every pull request URL that ends a line of one tool result's text.
 *
 * The result of `gh pr create` is routinely NOT one line: a `git push` in the
 * same command prints its `remote:` block first, `gh` itself prefixes warnings
 * (`Warning: 2 uncommitted changes`), and a loop over repositories prints one
 * URL per pull request it opened. Reading every line rather than the last is
 * what makes those shapes all work; reading only a URL that ENDS its line is
 * what keeps a quoted one out — see {@link PULL_REQUEST_URL_LINE}.
 */
export function readPullRequestUrls(
  text: string,
): Omit<RunPullRequest, 'seq'>[] {
  const found: Omit<RunPullRequest, 'seq'>[] = [];
  for (const raw of text.split('\n')) {
    const match = PULL_REQUEST_URL_LINE.exec(raw.trim());
    if (match === null) {
      continue;
    }
    const [, url, owner, repo, number] = match;
    // Every group is mandatory in the pattern, so a match has all four. The
    // guard is here because `exec` types them optional, and asserting would be
    // the same claim with nothing checking it.
    if (
      url === undefined ||
      owner === undefined ||
      repo === undefined ||
      number === undefined
    ) {
      continue;
    }
    found.push({ owner, repo, number: Number(number), url });
  }
  return found;
}

/**
 * The capture rule's version, stored beside the scan marker
 * (`Run.pullRequestsScanVersion`). Bump it with any change that would find
 * pull requests the previous rule missed: every run scanned under another
 * version is then read again from the start, once, and what it already carries
 * is merged rather than replaced.
 *
 * 2: a URL that ends its line after a label, and the CLI's own record of the
 * pull requests a session touched (`AgentAdapter.readSessionPullRequests`).
 * 3: a CLI's record is kept only when the run opened that pull request or its
 * thread names it ({@link textNamesPullRequest}); a record stored before is
 * checked again on the re-read and dropped when the thread does not.
 */
export const PULL_REQUEST_SCAN_VERSION = 3;

/**
 * The rows a thread names a pull request in: what the agent ran and was
 * answered, what it said, and the briefs and answers of its agent-to-agent
 * calls. A user's own message is a `message` row too.
 */
export const PULL_REQUEST_NAMING_KINDS: readonly ItemKind[] = [
  'tool_call',
  'tool_result',
  'message',
  'call_started',
  'call_result',
];

/**
 * What a row must contain to name `pullRequest` ({@link textNamesPullRequest}):
 * the number, and either the repository's pull path or a `gh pr` command. The
 * database's prefilter is built from these, so it can never be narrower than
 * the rule. `repoPath` is lower-cased, for a lower-cased payload: GitHub names
 * a repository in any case.
 */
export function pullRequestNamingNeedles(pullRequest: {
  owner: string;
  repo: string;
  number: number;
}): { number: string; repoPath: string; command: string } {
  return {
    number: String(pullRequest.number),
    repoPath: `${pullRequest.owner}/${pullRequest.repo}/pull`.toLowerCase(),
    command: GH_PR,
  };
}

const GH_PR = 'gh pr ';

/** A `gh pr <verb> ` at one index (sticky), its arguments following. */
const GH_PR_VERB = /\bgh pr [a-z-]+ /y;

/**
 * One piece of a command's arguments (sticky), read from a row's stored JSON,
 * so quotes arrive as `\"` and a newline as the two characters `\n`. Groups:
 * 1 a `\"…\"` span, 2 a `'…'` span — each ONE argument, whatever separators
 * it holds; 3 the end of the command — a separator outside any span, or a `"`
 * with no backslash, which ends the JSON string holding the command; 4 a bare
 * word; 5 any other single character (a `)` or backtick closing a
 * substitution, an unclosed quote).
 */
const ARGUMENT =
  /\s*(?:\\"((?:[^\\"]|\\[^"])*?)\\"|'([^'"]*)'|(\\n|[\n;&|]|")|((?:[^\s\\;&|"'`()]|\\(?![n"]))+)|(\\"|[^]))/y;

/** Prose punctuation a bare word may end in (`Use gh pr checkout 7207.`). */
const TRAILING_PUNCTUATION = /[.,:!?]+$/;

/**
 * Whether `payload` — a row's stored JSON — names this pull request: its
 * address (the web URL, or the API's `repos/<owner>/<repo>/pulls/<n>`), or a
 * `gh pr <verb>` command with an argument that IS its number (bare,
 * `#`-prefixed, or quoted). A longer number is another pull request, and so is
 * one inside a longer argument such as a quoted `--body`.
 *
 * What makes a CLI's own record of a pull request the thread's: claude answers
 * every push with `gh pr view` in its own folder, so it also records the pull
 * request of whatever branch that folder has checked out — in a shared
 * checkout, another thread's.
 *
 * Linear in `payload`: a row can be a large tool result, and a pattern that
 * backtracked over it would hold the daemon's event loop.
 */
export function textNamesPullRequest(
  payload: string,
  pullRequest: { owner: string; repo: string; number: number },
): boolean {
  // Owner and repository are `[\w.-]` by the capture's own URL rule, so a dot
  // is the one character that needs escaping.
  const path = `${pullRequest.owner}/${pullRequest.repo}`.replaceAll(
    '.',
    '\\.',
  );
  const address = new RegExp(
    `(?:github\\.com|repos)/${path}/pulls?/${pullRequest.number}(?!\\d)`,
    'i',
  );
  if (address.test(payload)) {
    return true;
  }
  const number = `${pullRequest.number}`;
  for (
    let at = payload.indexOf(GH_PR);
    at !== -1;
    at = payload.indexOf(GH_PR, at + 1)
  ) {
    GH_PR_VERB.lastIndex = at;
    if (!GH_PR_VERB.test(payload)) {
      continue;
    }
    ARGUMENT.lastIndex = GH_PR_VERB.lastIndex;
    for (
      let token = ARGUMENT.exec(payload);
      token !== null;
      token = ARGUMENT.exec(payload)
    ) {
      // Resume the search past what this command consumed, so a `gh pr`
      // inside its arguments is never read as a command of its own.
      at = token.index + token[0].length - 1;
      if (token[3] !== undefined) {
        break;
      }
      const word =
        token[1] ?? token[2] ?? token[4]?.replace(TRAILING_PUNCTUATION, '');
      if (word === number || word === `#${number}`) {
        return true;
      }
    }
  }
  return false;
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
 * The identity a recorded outcome is filed under: {@link pullRequestKey} with
 * owner and repo case-folded, since GitHub resolves them case-insensitively
 * and an agent may write a URL in another case than the capture saw.
 */
export function pullRequestOutcomeKey(pullRequest: {
  owner: string;
  repo: string;
  number: number;
}): string {
  return pullRequestKey(pullRequest).toLowerCase();
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
  limit: number = MAX_RUN_PULL_REQUESTS,
): RunPullRequest[] {
  const byKey = new Map<string, RunPullRequest>();
  for (const pullRequest of [...existing, ...captured]) {
    const key = pullRequestKey(pullRequest);
    const seen = byKey.get(key);
    if (seen === undefined || pullRequest.seq < seen.seq) {
      byKey.set(key, pullRequest);
    }
  }
  return [...byKey.values()].sort((a, b) => a.seq - b.seq).slice(0, limit);
}

/**
 * What a run SHOWS as its pull requests: the ones it opened and the ones its
 * CLI recorded touching, as one list in the order the thread reached them.
 * Only display reads this; ending a card and counting what a thread opened
 * read the opened column alone.
 *
 * `outcomes` is the run's `runOutcomes` column as `readRunOutcomes` reads it,
 * keyed by {@link pullRequestOutcomeKey}: every announce of the list carries
 * it, since the renderer replaces the whole list from each one.
 */
export function readDisplayedPullRequests(
  opened: string | null | undefined,
  touched: string | null | undefined,
  outcomes: ReadonlyMap<string, PullRequestOutcome>,
): DisplayedPullRequest[] {
  const openedRows = readRunPullRequests(opened);
  const openedKeys = new Set(openedRows.map(pullRequestKey));
  // Each column is capped on its own; capping the union again would let
  // touched pull requests push opened ones off the list.
  return mergePullRequests(
    openedRows,
    readRunPullRequests(touched),
    Number.POSITIVE_INFINITY,
  ).map((row) => {
    const key = pullRequestKey(row);
    return {
      ...row,
      opened: openedKeys.has(key),
      outcome: outcomes.get(pullRequestOutcomeKey(row)) ?? null,
    };
  });
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
