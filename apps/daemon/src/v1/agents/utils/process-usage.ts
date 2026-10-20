import { basename } from 'node:path';

import type { RunProcess } from '../chat.types';
import type { ProcessRow } from './process-descendants';
import { runPs } from './run-ps';

/** One row of the process table, with what it costs. */
export interface ProcessUsageRow extends ProcessRow {
  pgid: number;
  cpuPercent: number;
  rssBytes: number;
  elapsedSeconds: number | null;
  /**
   * The executable's own path (`ps -o comm`), or null when that listing did
   * not name this pid. Read separately from `args` because both can contain
   * spaces — cursor-agent lives under `Application Support` — so one `ps` line
   * cannot carry both and still be split.
   */
  comm: string | null;
}

/**
 * Executables that RUN something else, so the process is named after what
 * they run: `node /usr/local/bin/codegraph serve` is codegraph, not node.
 */
const INTERPRETERS = new Set([
  'node',
  'bun',
  'deno',
  'python',
  'python3',
  'ruby',
  'perl',
]);

/** Flags by which an interpreter runs code from argv instead of a script. */
const INLINE_CODE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c']);

/**
 * The whole process table with CPU and memory, or null when `ps` could not be
 * read — unlike `listProcesses`, whose empty answer is safe for its callers,
 * a readout must be able to say "unknown" rather than "nothing is running".
 */
export async function listProcessUsage(): Promise<ProcessUsageRow[] | null> {
  const [usage, comms] = await Promise.all([
    runPs(['-axww', '-o', 'pid=,ppid=,pgid=,%cpu=,rss=,etime=,args=']),
    runPs(['-axww', '-o', 'pid=,comm=']),
  ]);
  if (usage === null) {
    return null;
  }
  return parseProcessUsage(usage, comms === null ? '' : comms);
}

/**
 * `ps` output into rows. A line that does not parse is skipped, on
 * `parseProcessRows`'s rule: a header read as pid 0 would adopt the machine.
 */
export function parseProcessUsage(
  usage: string,
  comms: string,
): ProcessUsageRow[] {
  const commByPid = new Map<number, string>();
  for (const line of comms.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match) {
      commByPid.set(Number(match[1]), (match[2] ?? '').trim());
    }
  }
  const rows: ProcessUsageRow[] = [];
  for (const line of usage.split('\n')) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(
        line,
      );
    if (match === null) {
      continue;
    }
    const pid = Number(match[1]);
    const args = (match[7] ?? '').trim();
    const cpuPercent = Number((match[4] ?? '').replace(',', '.'));
    if (!Number.isInteger(pid) || pid <= 0 || args === '') {
      continue;
    }
    rows.push({
      pid,
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : 0,
      // `ps` reports resident size in KiB.
      rssBytes: Number(match[5]) * 1024,
      elapsedSeconds: parseElapsed(match[6] ?? ''),
      args: decodePsText(args),
      comm: decodeComm(commByPid.get(pid)),
    });
  }
  return rows;
}

function decodeComm(comm: string | undefined): string | null {
  return comm === undefined ? null : decodePsText(comm);
}

/** One `vis(3)` escape `ps` writes: an octal byte, or a meta byte. */
const VIS_RUN = /(?:\\[0-7]{3}|M-\^?.|M\^.)+/g;

/**
 * Undo the `vis(3)` encoding macOS `ps` applies to every non-printable byte:
 * a newline arrives as `\012`, and an em dash — three UTF-8 bytes — as
 * `M-bM^@M^T`. A command line read without this shows its prompt as escape
 * soup.
 *
 * A run is decoded only when its bytes form valid UTF-8 (or are an octal
 * escape on their own), because `ps` does NOT escape a literal backslash or a
 * literal `M-`: `grep -M-b` must not turn into a byte.
 */
export function decodePsText(text: string): string {
  return text.replace(VIS_RUN, (run) => {
    const bytes: number[] = [];
    for (const piece of run.match(/\\[0-7]{3}|M-\^?.|M\^./g) ?? []) {
      if (piece.startsWith('\\')) {
        bytes.push(parseInt(piece.slice(1), 8));
      } else if (piece.startsWith('M^') || piece.startsWith('M-^')) {
        const ch = piece.charCodeAt(piece.length - 1);
        // `M^?` is DEL with the meta bit; any other `^X` is a control byte.
        bytes.push(0x80 | (ch === 0x3f ? 0x7f : ch & 0x1f));
      } else {
        bytes.push(0x80 | piece.charCodeAt(2));
      }
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(bytes),
      );
    } catch {
      return run;
    }
  });
}

/** `ps`'s `etime` — `[[dd-]hh:]mm:ss` — in seconds, or null if malformed. */
export function parseElapsed(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (match === null) {
    return null;
  }
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

/**
 * What a process IS, in one word: the executable, or the script an
 * interpreter is running.
 */
export function processName(
  row: Pick<ProcessUsageRow, 'args' | 'comm'>,
): string {
  // argv[0] is the executable path when it was spawned by path, and that path
  // can hold spaces — so it is matched against `comm` rather than split. Only
  // a PATH: a process that retitled itself (`npm exec …`) reports the title
  // as its comm, and the title's last word is not what the process is.
  const byComm =
    row.comm !== null &&
    row.comm.startsWith('/') &&
    row.args.startsWith(row.comm);
  const argv0 = byComm
    ? (row.comm as string)
    : (row.args.split(/\s+/)[0] ?? '');
  const exe = basename(argv0) || argv0;
  const tokens = row.args.slice(argv0.length).trim().split(/\s+/);
  const scriptAt = interpretedScriptAt(exe, tokens);
  const script = scriptAt === -1 ? undefined : tokens[scriptAt];
  return script === undefined ? exe : basename(script) || script;
}

/**
 * Where, in the arguments after the executable, the script an interpreter
 * runs is — or -1 for an executable that is no interpreter, or one running
 * inline code: `node -e <code>`'s first word is source text, not a program.
 */
function interpretedScriptAt(exe: string, args: readonly string[]): number {
  if (!INTERPRETERS.has(exe)) {
    return -1;
  }
  const scriptAt = args.findIndex(
    (token) => token !== '' && !token.startsWith('-'),
  );
  const inline = args
    .slice(0, scriptAt === -1 ? args.length : scriptAt)
    .some((token) => INLINE_CODE_FLAGS.has(token));
  return inline ? -1 : scriptAt;
}

/**
 * A set of processes laid out as the forest their parent links make: each
 * whose parent is outside the set is a `root`, the rest hang under it in pid
 * order. For what a run owns with no CLI of its own above it — what its agents
 * left running detached.
 */
export function processSetTree(
  rows: readonly ProcessUsageRow[],
  pids: ReadonlySet<number>,
): OwnedProcess[] {
  const members = rows
    .filter((row) => pids.has(row.pid))
    .sort((a, b) => a.pid - b.pid);
  const byParent = new Map<number, ProcessUsageRow[]>();
  for (const row of members) {
    const siblings = byParent.get(row.ppid);
    if (siblings) {
      siblings.push(row);
    } else {
      byParent.set(row.ppid, [row]);
    }
  }
  const out: OwnedProcess[] = [];
  const seen = new Set<number>();
  const visit = (row: ProcessUsageRow, depth: number): void => {
    if (seen.has(row.pid)) {
      return;
    }
    seen.add(row.pid);
    out.push({ ...row, depth, link: depth === 0 ? 'root' : 'child' });
    for (const child of byParent.get(row.pid) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const row of members) {
    if (!pids.has(row.ppid)) {
      visit(row, 0);
    }
  }
  // A cycle in a non-atomic snapshot has no top; still the run's, so listed.
  for (const row of members) {
    visit(row, 0);
  }
  return out;
}

/** A process counted as one CLI's, placed in that CLI's tree. */
export interface OwnedProcess extends ProcessUsageRow {
  depth: number;
  link: RunProcess['link'];
}

/**
 * Every process that belongs to the CLI spawned as `rootPid` — the CLI itself
 * first, then its tree depth-first — or an empty list once it has gone.
 *
 * Membership is decided by two facts the OS keeps, never by command text:
 *
 * - parent links, walked to any depth (a CLI's command runs under a shell, so
 *   the command is a grandchild);
 * - the process GROUP, which catches what parent links lose. A command whose
 *   launching shell exited is reparented to launchd (ppid 1), but it stays in
 *   the group the CLI's `detached` spawn created — a group nothing outside
 *   that spawn joins.
 *
 * The group arm applies only when the root LEADS its group. A root that does
 * not shares its group with whoever spawned it, and matching on that group
 * would claim the daemon and everything beside it.
 */
export function processTreeOf<T extends ProcessRow & { pgid: number }>(
  rows: readonly T[],
  rootPid: number,
): (T & Pick<OwnedProcess, 'depth' | 'link'>)[] {
  const root = rows.find((row) => row.pid === rootPid);
  if (root === undefined) {
    return [];
  }
  const byParent = new Map<number, T[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings) {
      siblings.push(row);
    } else {
      byParent.set(row.ppid, [row]);
    }
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.pid - b.pid);
  }

  const out: (T & Pick<OwnedProcess, 'depth' | 'link'>)[] = [];
  // `seen` guards against the cycles a non-atomic `ps` snapshot can contain —
  // see `descendantsOf`.
  const seen = new Set<number>();
  const visit = (start: T, depth: number, link: OwnedProcess['link']): void => {
    const stack: {
      row: T;
      depth: number;
      link: OwnedProcess['link'];
    }[] = [{ row: start, depth, link }];
    while (stack.length > 0) {
      const next = stack.pop() as (typeof stack)[number];
      if (seen.has(next.row.pid)) {
        continue;
      }
      seen.add(next.row.pid);
      out.push({ ...next.row, depth: next.depth, link: next.link });
      const children = byParent.get(next.row.pid) ?? [];
      // Pushed in reverse so they pop — and are listed — in pid order.
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i] as T;
        stack.push({ row: child, depth: next.depth + 1, link: 'child' });
      }
    }
  };
  visit(root, 0, 'root');

  if (root.pgid === root.pid) {
    const strays = rows.filter(
      (row) => row.pgid === root.pid && !seen.has(row.pid),
    );
    const strayPids = new Set(strays.map((row) => row.pid));
    // Only the TOP of each stray subtree is attached here; its own children
    // follow it through the parent links.
    for (const stray of strays) {
      if (!strayPids.has(stray.ppid)) {
        visit(stray, 1, 'group');
      }
    }
    // Anything left is a stray whose parent is ALSO a stray but which the walk
    // never reached — a cycle in the snapshot. Still the group's, so listed.
    for (const stray of strays) {
      if (!seen.has(stray.pid)) {
        visit(stray, 1, 'group');
      }
    }
  }
  return out;
}
