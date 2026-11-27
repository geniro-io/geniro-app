import { isSameProcess } from '../../../utils/process-identity';
import type { CommandRecord } from '../adapters/adapter.types';
import { decodePsText } from './process-usage';
import type { PlainProcess } from './run-process-scan';
import { runPs } from './run-ps';

/** One row of the process table, as `ps` reports it. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** The full command line, un-truncated (`ps -ww`). */
  args: string;
}

/**
 * How much of a command has to match. `ps` reports the whole line, but a CLI
 * may run a command through a shell that rewrites its tail, so the comparison
 * is a PREFIX of what the agent asked for rather than the whole string. Long
 * enough that two genuinely different commands cannot share it, short enough to
 * survive the wrapping.
 */
const COMMAND_MATCH_CHARS = 120;

/**
 * The process table, or an empty list when it cannot be read.
 *
 * `-ww` is not cosmetic: without it `ps` truncates `args` to the terminal width,
 * and the commands worth recognising here are the long ones. An empty list is
 * the honest answer to a failure — every caller treats "not found" as "nothing
 * is running", which is the safe direction: a missed detachment costs a row
 * that should have been listed, while a fabricated one lists a command that
 * finished and can never be un-listed.
 */
export async function listProcesses(): Promise<ProcessRow[]> {
  const stdout =
    (await runPs(['-axww', '-o', 'pid=,ppid=,args='], 8 * 1024 * 1024)) ?? '';
  return parseProcessRows(stdout);
}

/**
 * `ps` output into rows — split out from the spawn so the parsing is testable
 * without a process, which is the rule every mapper in this module follows.
 *
 * A line that does not begin with two integers is skipped rather than guessed
 * at: this is another program's output, and a header or a warning line reaching
 * the tree as pid 0 would reparent half the machine under it.
 */
export function parseProcessRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const args = (match[3] ?? '').trim();
    if (!Number.isInteger(pid) || pid <= 0 || args === '') {
      continue;
    }
    // `ps` escapes every non-ASCII byte under the C locale it runs in; the
    // commands matched against these rows are the agent's own text.
    rows.push({ pid, ppid, args: decodePsText(args) });
  }
  return rows;
}

/**
 * A process group a detached command runs in, as recorded while the CLI that
 * started it was alive: its members, each with its kernel start time.
 */
export interface RecordedGroup {
  pgid: number;
  members: readonly { pid: number; startedAt: number }[];
}

/**
 * Whether `group` is still the group that was recorded: one of its recorded
 * members is alive in it and is still the process recorded (its start time).
 *
 * A group id cannot be reused while any member of the group lives, so this is
 * what makes the id safe to act on later; without it a recycled id could name a
 * stranger's group.
 */
export function isGroupAnchored(
  group: RecordedGroup,
  rows: readonly PlainProcess[],
): boolean {
  const inGroup = new Map<number, number>();
  for (const row of rows) {
    if (row.pgid === group.pgid && row.startedAt !== null) {
      inGroup.set(row.pid, row.startedAt);
    }
  }
  return group.members.some((member) =>
    isSameProcess(member.pid, member.startedAt, inGroup),
  );
}

/**
 * The processes still running in `groups`, with every process they have
 * started since, wherever its own group is.
 */
export function groupSubtree(
  rows: readonly PlainProcess[],
  groups: readonly RecordedGroup[],
): Set<number> {
  const pgids = new Set(groups.map((group) => group.pgid));
  return new Set(
    rows
      .filter((row) => pgids.has(row.pgid))
      .flatMap((row) => [
        row.pid,
        ...descendantsOf(rows, row.pid).map(({ pid }) => pid),
      ]),
  );
}

/**
 * Every process descending from `rootPid`, at any depth.
 *
 * Depth matters and is the reason this walks rather than filtering on `ppid`:
 * a CLI runs its commands through a shell, so the command itself is a
 * GRANDCHILD — measured on cursor-agent, `sleep 300` under `/bin/zsh` under
 * `cursor-agent` under the daemon.
 *
 * The root itself is excluded: it is the agent, never one of its commands.
 */
export function descendantsOf<T extends ProcessRow>(
  rows: readonly T[],
  rootPid: number,
): T[] {
  const byParent = new Map<number, T[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings) {
      siblings.push(row);
    } else {
      byParent.set(row.ppid, [row]);
    }
  }
  const found: T[] = [];
  // Iterative, and `seen` is not paranoia: `ps` takes no atomic snapshot, so a
  // process that exits mid-listing can leave a row whose parent has already
  // been reparented — a cycle in the table is rare and would otherwise hang the
  // walk inside a turn's settle.
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.pop() as number;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) {
        continue;
      }
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/**
 * Whether any of these processes is running `command`.
 *
 * A CONTAINS on a normalized prefix rather than an equality, because a CLI may
 * wrap what it runs, and the wrapper and the command are one answer to the only
 * question asked here — is this command still alive under that agent. A command
 * whose text never reaches the table is {@link commandLiveness}'s to answer.
 *
 * Whitespace is collapsed on both sides: a multi-line command reaches `ps` as
 * one line, so comparing the agent's own newlines against it never matches.
 */
export function isCommandRunning(
  processes: readonly ProcessRow[],
  command: string,
): boolean {
  return pidsRunningCommand(processes, command).length > 0;
}

/**
 * WHICH processes are running `command` — {@link isCommandRunning}'s answer,
 * with the rows kept.
 *
 * One matcher for both, deliberately: the question "is this still running" and
 * the question "what do I kill to stop it" must never be able to disagree, and
 * a second normalization is how they would. The reading is
 * {@link isCommandRunning}'s in full — a contains on a normalized prefix,
 * because a CLI wraps what it runs.
 *
 * That looseness is why the caller kills a process GROUP and not a pid: the
 * wrapper and the command it wraps are two rows for one thing, and both are
 * this answer.
 */
export function pidsRunningCommand(
  processes: readonly ProcessRow[],
  command: string,
): number[] {
  const needle = normalizeCommand(command).slice(0, COMMAND_MATCH_CHARS);
  // An empty needle would match EVERY row. That is a difference of one
  // character from killing the user's whole process table, so it is refused
  // here rather than left to each caller to remember.
  if (needle === '') {
    return [];
  }
  return processes
    .filter((row) => normalizeCommand(row.args).includes(needle))
    .map((row) => row.pid);
}

/**
 * Answers, per command line, whether a process of `alive` still runs it. A line
 * the CLI recorded is decided by its records, each answering for one call: its
 * text is not always in the table (a heredoc), and a finished record is proof.
 * Any other line falls back to {@link isCommandRunning}.
 */
export function commandLiveness(
  alive: readonly ProcessRow[],
  records: readonly CommandRecord[],
): (command: string) => boolean {
  const known = new Set(records.map((r) => normalizeCommand(r.command)));
  const liveCounts = new Map<string, number>();
  for (const line of known) {
    liveCounts.set(line, recordedPidsRunning(alive, records, line).length);
  }
  return (command) => {
    const line = normalizeCommand(command);
    if (!known.has(line)) {
      return isCommandRunning(alive, command);
    }
    const left = liveCounts.get(line) ?? 0;
    liveCounts.set(line, Math.max(0, left - 1));
    return left > 0;
  };
}

/** The processes of `alive` the CLI recorded as running `command`. */
export function recordedPidsRunning(
  alive: readonly ProcessRow[],
  records: readonly CommandRecord[],
  command: string,
): number[] {
  const line = normalizeCommand(command);
  const pids = new Set(alive.map((row) => row.pid));
  return records
    .filter(
      (record) =>
        record.running &&
        pids.has(record.pid) &&
        normalizeCommand(record.command) === line,
    )
    .map((record) => record.pid);
}

/**
 * The newest record of `command` that ended at or after `notBeforeMs`, or null:
 * an earlier run of the same line is not this call's.
 */
export function endedRecordOf(
  records: readonly CommandRecord[],
  command: string,
  notBeforeMs: number,
): CommandRecord | null {
  const line = normalizeCommand(command);
  let newest: CommandRecord | null = null;
  for (const record of records) {
    const endedMs = Date.parse(record.endedAt ?? '');
    if (
      record.running ||
      normalizeCommand(record.command) !== line ||
      !(endedMs >= notBeforeMs)
    ) {
      continue;
    }
    if (newest === null || (record.endedAt ?? '') >= (newest.endedAt ?? '')) {
      newest = record;
    }
  }
  return newest;
}

function normalizeCommand(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function withoutQuoting(value: string): string {
  return value.replace(/['"\\]/g, '');
}

/**
 * Every string a command the agent wrote can appear as in the process table —
 * the command itself first, then what its shell actually leaves running.
 *
 * The command as written is often NOT in the table at all. A CLI hands it to a
 * shell (codex: `/bin/zsh -lc '<command>'`), and a shell given one simple
 * command EXECS it rather than forking, as does `env`: measured on macOS,
 * `/bin/zsh -lc 'env -u FOO BAR=1 sleep 37 > log 2>&1'` is a single row reading
 * `sleep 37` a second later — no `zsh`, no `env`, no quotes, no redirection.
 * So matching the written text alone found nothing, and a Stop on such a
 * command answered "no longer running" over a `pnpm dev` that ran on.
 *
 * The derived needles are LOOSER than the written command, which is why they
 * are for a search the caller has already confined to its own run's process
 * tree ({@link ChatShellsService.kill}'s foreground arm) and never for the whole
 * table. Shell builtins (`cd`, `export`, …) leave no process, so a segment
 * naming one is dropped, and so is anything shorter than
 * {@link MIN_NEEDLE_CHARS}: a two-letter needle matches half of any tree.
 *
 * This is a reading of common shapes, not a shell parser — a needle that
 * matches nothing costs only the fallback sentence, never a wrong kill outside
 * the run.
 */
export function commandNeedles(command: string): string[] {
  const { whole, parts } = needleSets(command);
  return [...new Set([...whole, ...parts])];
}

/**
 * {@link commandNeedles} in two sets: the command's whole text (as written, and
 * the script a shell was handed), then the single commands it runs.
 */
function needleSets(command: string): { whole: string[]; parts: string[] } {
  const body = unwrapShell(command.trim());
  return {
    whole: specific([
      normalizeCommand(command),
      ...(body === null ? [] : [normalizeCommand(body)]),
    ]),
    parts: specific(
      commandSegments(body ?? command).flatMap((segment) => {
        const core = commandCore(normalizeCommand(segment));
        return core === null ? [] : [core];
      }),
    ),
  };
}

function specific(needles: readonly string[]): string[] {
  return [...new Set(needles)].filter(
    (needle) => needle.length >= MIN_NEEDLE_CHARS,
  );
}

/**
 * Which of a run's processes ARE this command: the matches of the most specific
 * needle that matches anything, each kept only when no ancestor of it matched
 * too — the wrapper and what it wraps are one command, stopped through the top.
 *
 * The table never carries the agent's quoting as written: claude evals the
 * command from a single-quoted string (each `'` written `'"'"'`), and the
 * program a shell execs shows its argv with no quotes at all. So when no needle
 * matches as written, the needles and the rows are compared again with their
 * quoting removed.
 *
 * `owned` must already be confined to one run's own process tree: the derived
 * needles are looser than the command (see {@link commandNeedles}). A single
 * command of a script is looser still, so it never reaches a process that one
 * of `others` — the commands running beside it — matches, nor what that
 * process started.
 */
export function commandTargets(
  owned: readonly ProcessRow[],
  command: string,
  others: readonly string[] = [],
): number[] {
  const unquoted = owned.map((row) => ({
    ...row,
    args: withoutQuoting(row.args),
  }));
  const { whole, parts } = needleSets(command);
  let held: Set<number> | null = null;
  const apart = (rows: readonly ProcessRow[]): readonly ProcessRow[] => {
    held ??= heldByOthers(owned, others);
    const taken = held;
    return rows.filter((row) => !taken.has(row.pid));
  };
  const unquote = (needles: readonly string[]): string[] =>
    specific(needles.map(withoutQuoting));
  const readings: [() => readonly ProcessRow[], string[]][] = [
    [() => owned, whole],
    [() => apart(owned), parts],
    [() => unquoted, unquote(whole)],
    [() => apart(unquoted), unquote(parts)],
  ];
  for (const [rows, needles] of readings) {
    const targets = topMatches(rows(), needles);
    if (targets.length > 0) {
      return targets;
    }
  }
  return [];
}

/**
 * The programs a command feeds a heredoc to, as `ps` shows each once the
 * shell has exec'd it (`perl -`, `node -`): nothing of the script is left in
 * the table. Too bare for a Stop, which {@link commandTargets} never reads them
 * for; a caller recording where a command runs may, through
 * {@link pidsRunningProgram}.
 */
export function heredocPrograms(command: string): string[] {
  const body = unwrapShell(command.trim());
  return specific(
    commandSegments(body ?? command).flatMap((segment) => {
      const read = readSegment(normalizeCommand(segment));
      return read?.feedsHeredoc === true ? [read.text] : [];
    }),
  );
}

/** The rows whose whole command line is `program`, by name or by path. */
export function pidsRunningProgram(
  rows: readonly ProcessRow[],
  program: string,
): number[] {
  return rows
    .filter((row) => {
      const line = normalizeCommand(row.args);
      return line === program || line.endsWith(`/${program}`);
    })
    .map((row) => row.pid);
}

/** What any of `others` matches among `owned`, with everything it started. */
function heldByOthers(
  owned: readonly ProcessRow[],
  others: readonly string[],
): Set<number> {
  return new Set(
    others
      .flatMap((other) => commandTargets(owned, other))
      .flatMap((pid) => [
        pid,
        ...descendantsOf(owned, pid).map((row) => row.pid),
      ]),
  );
}

/** The matches of the first needle that matches anything, wrappers over what they wrap. */
function topMatches(
  rows: readonly ProcessRow[],
  needles: readonly string[],
): number[] {
  for (const needle of needles) {
    const matched = new Set(pidsRunningCommand(rows, needle));
    if (matched.size === 0) {
      continue;
    }
    const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]));
    return [...matched].filter((pid) => {
      const seen = new Set<number>([pid]);
      let parent = parentOf.get(pid);
      while (parent !== undefined && !seen.has(parent)) {
        if (matched.has(parent)) {
          return false;
        }
        seen.add(parent);
        parent = parentOf.get(parent);
      }
      return true;
    });
  }
  return [];
}

/** Shorter than this, a needle matches too much of any process tree. */
const MIN_NEEDLE_CHARS = 6;

/**
 * `&&`, `||`, `;`, `|` and a backgrounding `&` — where one command ends. The `&`
 * of a redirection (`2>&1`, `&>`) is not a separator.
 */
const SHELL_SEPARATORS = /\s*(?:&&|\|\||;|\||(?<![<>])&(?!>))\s*/;

/** A shell running one `-c` string: `/bin/zsh -lc '…'`, `bash -c "…"`. */
const SHELL_WRAPPER =
  /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+-[a-z]*c[a-z]*\s+(['"])([\s\S]*)\1$/;

/** Builtins: they run inside the shell and leave nothing to find. */
const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  'cd',
  'export',
  'source',
  '.',
  'set',
  'unset',
  'echo',
  'printf',
  'true',
  'false',
  'exec',
]);

function unwrapShell(command: string): string | null {
  const match = SHELL_WRAPPER.exec(command);
  if (match === null) {
    return null;
  }
  const [, quote, raw = ''] = match;
  // `'\''` is how a single quote is written inside a single-quoted string.
  return quote === "'" ? raw.replace(/'\\''/g, "'") : raw;
}

/**
 * The commands a script runs one after another: each line, split at the
 * separators within it. A shell execs the last line of a script in place of
 * itself, so only that line's own text is left in the table. A heredoc's body
 * is input, not commands, and is skipped to its delimiter.
 */
function commandSegments(script: string): string[] {
  const segments: string[] = [];
  let heredocEnd: string | null = null;
  for (const line of script.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    if (heredocEnd !== null) {
      if (line.trim() === heredocEnd) {
        heredocEnd = null;
      }
      continue;
    }
    heredocEnd = HEREDOC_START.exec(line)?.[2] ?? null;
    segments.push(...line.split(SHELL_SEPARATORS));
  }
  return segments;
}

/** `<<WORD`, `<< 'WORD'`, `<<-"WORD"` — never a `<<<` here-string. */
const HEREDOC_START = /(?<!<)<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/;

/**
 * What a segment leaves running once `nohup`, `env` and the shell have exec'd
 * away (see {@link readSegment}). None for a heredoc: what is left of it is a
 * bare program name, which would match every other run of that program in the
 * tree.
 */
function commandCore(segment: string): string | null {
  const read = readSegment(segment);
  return read === null || read.feedsHeredoc ? null : read.text;
}

/**
 * A segment as `ps` shows it once `nohup`, `env` and the shell have exec'd
 * away: a leading `nohup`, the `env [-i] [-u NAME]…` and `NAME=value`
 * assignments dropped, and everything from the first redirection or a `#`
 * comment on cut, since `ps` never shows either — outside quotes only.
 * `feedsHeredoc` when the cut was a heredoc's `<<`.
 */
function readSegment(
  segment: string,
): { text: string; feedsHeredoc: boolean } | null {
  const words = segment.trim().split(' ');
  if (words[0] === 'nohup') {
    words.shift();
  }
  if (words[0] === 'env') {
    words.shift();
    while (words[0]?.startsWith('-')) {
      // `-u NAME` takes the next word; `-i` and `-` stand alone.
      if (words.shift() === '-u') {
        words.shift();
      }
    }
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(words[0] ?? '')) {
    words.shift();
  }
  const rest: string[] = [];
  let quote: string | null = null;
  let feedsHeredoc = false;
  for (const word of words) {
    if (quote === null) {
      if (/^\d*<<(?!<)/.test(word)) {
        feedsHeredoc = true;
        break;
      }
      if (word.startsWith('#') || /^\d*[<>]/.test(word)) {
        break;
      }
    }
    rest.push(word);
    quote = quoteOpenAfter(word, quote);
  }
  const [program] = rest;
  if (program === undefined || program === '' || SHELL_BUILTINS.has(program)) {
    return null;
  }
  return { text: rest.join(' '), feedsHeredoc };
}

/** The quote still open once `word` is read, from `open` before it. */
function quoteOpenAfter(word: string, open: string | null): string | null {
  let quote = open;
  for (let i = 0; i < word.length; i += 1) {
    const char = word[i];
    if (char === '\\' && quote !== "'") {
      i += 1;
    } else if (quote === null && (char === "'" || char === '"')) {
      quote = char;
    } else if (char === quote) {
      quote = null;
    }
  }
  return quote;
}
