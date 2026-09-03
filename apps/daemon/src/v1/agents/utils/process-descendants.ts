import { execFile } from 'node:child_process';

/** One row of the process table, as `ps` reports it. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** The full command line, un-truncated (`ps -ww`). */
  args: string;
}

/**
 * How long a listing may take before it is abandoned. `ps` on a busy laptop
 * answers in single-digit milliseconds; anything near this is a machine in
 * trouble, and a readout is never worth blocking a turn's settle for.
 */
const PS_TIMEOUT_MS = 4_000;

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
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      'ps',
      ['-axww', '-o', 'pid=,ppid=,args='],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, out) => resolve(error ? '' : out),
    );
  });
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
    rows.push({ pid, ppid, args });
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
  const needle = normalizeCommand(command).slice(0, COMMAND_MATCH_CHARS);
  if (needle === '') {
    return false;
  }
  return processes.some((row) => normalizeCommand(row.args).includes(needle));
}

function normalizeCommand(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
