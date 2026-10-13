import { decodePsText } from './process-usage';
import { runPs } from './run-ps';

/** One row of the process table, as `ps` reports it. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** The full command line, un-truncated (`ps -ww`). */
  args: string;
}

/**
 * How much of a command has to match. `ps` reports the whole line, but a shell
 * wrapper rewrites the tail (cursor's is a ~400-character zsh preamble ending
 * `-- <command>`), so the comparison is a PREFIX of what the agent asked for
 * rather than the whole string. Long enough that two genuinely different
 * commands cannot share it, short enough to survive the wrapping.
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
 * Every process descending from `rootPid`, at any depth.
 *
 * Depth matters and is the reason this walks rather than filtering on `ppid`:
 * a CLI runs its commands through a shell, so the command itself is a
 * GRANDCHILD — measured on cursor-agent, `sleep 300` under `/bin/zsh` under
 * `cursor-agent` under the daemon.
 *
 * The root itself is excluded: it is the agent, never one of its commands.
 */
export function descendantsOf(
  rows: readonly ProcessRow[],
  rootPid: number,
): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings) {
      siblings.push(row);
    } else {
      byParent.set(row.ppid, [row]);
    }
  }
  const found: ProcessRow[] = [];
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
 * A CONTAINS on a normalized prefix rather than an equality, because a CLI
 * wraps what it runs: cursor's `sleep 300` appears twice in the table, once as
 * itself and once inside a zsh preamble that sets up its sandbox and ends
 * `-- sleep 300`. Either row is the same answer to the only question asked
 * here — is this command still alive under that agent.
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

function normalizeCommand(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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
  const written = normalizeCommand(command);
  const needles = [written];
  const inner = unwrapShell(written);
  if (inner !== null) {
    needles.push(inner);
  }
  for (const segment of (inner ?? written).split(SHELL_SEPARATORS)) {
    const core = commandCore(segment);
    if (core !== null) {
      needles.push(core);
    }
  }
  return [...new Set(needles)].filter(
    (needle) => needle.length >= MIN_NEEDLE_CHARS,
  );
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
  const body = quote === "'" ? raw.replace(/'\\''/g, "'") : raw;
  return normalizeCommand(body);
}

/**
 * What a segment leaves running once `env` and the shell have exec'd away: the
 * leading `env [-i] [-u NAME]…` and `NAME=value` assignments dropped, and
 * everything from the first redirection on cut, since `ps` never shows one.
 */
function commandCore(segment: string): string | null {
  const words = segment.trim().split(' ');
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
  for (const word of words) {
    if (/^\d*[<>]/.test(word)) {
      break;
    }
    rest.push(word);
  }
  const [program] = rest;
  if (program === undefined || program === '' || SHELL_BUILTINS.has(program)) {
    return null;
  }
  return rest.join(' ');
}
