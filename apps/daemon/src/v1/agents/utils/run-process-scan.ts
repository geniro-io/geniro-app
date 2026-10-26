import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

import { runPs } from './run-ps';

/**
 * The env var every run-scoped agent CLI is spawned with, carrying its RUN id.
 * Every descendant inherits it — a dev server the agent detached with `nohup`
 * and that launchd adopted included — which is how a thread's processes are
 * found once nothing the daemon holds points at them any more.
 */
export const RUN_ID_ENV = 'GENIRO_RUN_ID';

/**
 * Which geniro the run belongs to — see {@link runOwnerOf}. Without it a dev
 * build on its own profile would read the installed app's runs as deleted
 * (they are not in ITS database) and sweep their processes away.
 */
export const RUN_OWNER_ENV = 'GENIRO_RUN_OWNER';

/**
 * The most processes one run's teardown will signal. A real run's dev stands,
 * watchers and browsers come to a few dozen; a selection past this is a filter
 * that matched something it should not, and the answer is to kill nothing.
 */
export const RUN_PROCESS_CAP = 250;

/**
 * The owner tag of the geniro whose data lives in `userDataDir`. A hash, not
 * the path: `ps -E` joins the environment with spaces, and the default profile
 * lives under `Application Support`.
 */
export function runOwnerOf(userDataDir: string): string {
  return createHash('sha256')
    .update(resolve(userDataDir))
    .digest('hex')
    .slice(0, 16);
}

/** The env a run-scoped CLI is spawned with, on top of its own. */
export function runTagEnv(
  runId: string,
  owner: string,
): Record<string, string> {
  return { [RUN_ID_ENV]: runId, [RUN_OWNER_ENV]: owner };
}

/** One process, as the two `ps` listings the scan joins describe it. */
export interface ScannedProcess {
  pid: number;
  ppid: number;
  /** Its process group — what a command an agent left running is recorded by. */
  pgid: number;
  uid: number;
  /** Its controlling terminal (`ttys003`), or null when it has none. */
  tty: string | null;
  /** Kernel start time (epoch ms) — null when `ps` printed one that will not parse. */
  startedAt: number | null;
  args: string;
  /**
   * The environment, space-joined as `ps -E` prints it — null when it could
   * not be told apart from the arguments (see {@link envSuffix}).
   */
  env: string | null;
}

/** A process as the plain listing alone describes it, with no environment. */
export type PlainProcess = Omit<ScannedProcess, 'env'>;

/** A process a stop action may name; its start time is what a press re-checks. */
export type StopCandidate = ScannedProcess & { startedAt: number };

/** Whose processes a scan may attribute, and what it must never touch. */
export interface AttributionScope {
  /** This geniro's {@link runOwnerOf}. */
  owner: string;
  /** The daemon's own pid — it and every ancestor of it are never a run's. */
  selfPid: number;
  /** The user the daemon runs as; another user's process is never a run's. */
  uid: number;
}

/** What a teardown is about to signal, or why it signals nothing. */
export interface RunProcessSelection {
  targets: ScannedProcess[];
  /** What matched when that was over the cap — null when it was not. */
  overCap: { count: number; sample: ScannedProcess[] } | null;
}

/** How many of an over-cap match the warning names. */
const OVER_CAP_SAMPLE = 10;

/** The operating system's and the installed apps' executables are never a run's. */
const SYSTEM_EXECUTABLE =
  /^(?:\/Users\/[^/]+)?\/Applications\/|^\/System\/|^\/usr\/libexec\//;

/**
 * The container VM. One VM serves every project on the machine, so stopping
 * it — even one this run's agent happened to start — takes down every other
 * session's containers. Named, because nothing in the process table tells a
 * shared VM from a private one.
 */
const CONTAINER_VM = /^(?:colima|lima|limactl)$/;
/** Lima's own directory under any home (`$COLIMA_HOME/_lima`), and the defaults. */
const CONTAINER_VM_DIRS = ['/_lima/', '/.colima/', '/.lima/'];

const PLAIN_COLUMNS = [
  '-axww',
  '-o',
  'pid=,ppid=,pgid=,uid=,tt=,lstart=,args=',
];

// `lstart` is five fields with a space-padded day: `Mon Oct  5 17:34:22 2026`.
const PLAIN_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;
const ENV_ROW = /^\s*(\d+) (.*)$/;

/**
 * The process table with each row's environment, or null when it could not be
 * read — and an unreadable table attributes nothing.
 *
 * Two listings because `ps -E` prints the environment glued to the arguments;
 * the plain one is what tells them apart (see {@link envSuffix}).
 */
export async function scanProcessTable(): Promise<ScannedProcess[] | null> {
  const [plain, withEnv] = await Promise.all([
    runPs(PLAIN_COLUMNS),
    // Every process's whole environment: a few MB on a busy machine.
    runPs(['-axwwE', '-o', 'pid=,args='], 64 * 1024 * 1024),
  ]);
  if (plain === null || withEnv === null) {
    return null;
  }
  const rows = parseScan(plain, withEnv);
  // A real table always lists launchd: nothing parsed means a format this
  // parser cannot read, which must be said rather than read as "nothing runs".
  return rows.length === 0 ? null : rows;
}

/**
 * The plain listing alone, or null when it could not be read: what a session
 * reads while a command it ran is out, where the megabytes of `ps -E` buy
 * nothing.
 */
export async function scanPlainTable(): Promise<PlainProcess[] | null> {
  const plain = await runPs(PLAIN_COLUMNS);
  if (plain === null) {
    return null;
  }
  const rows = parsePlainTable(plain);
  // As in {@link scanProcessTable}: an empty parse is an unreadable format.
  return rows.length === 0 ? null : rows;
}

/**
 * `ps -axww -o pid=,ppid=,pgid=,uid=,tt=,lstart=,args=` into rows. A line that
 * does not open the way it was asked to is skipped rather than guessed at —
 * this is another program's output, and a header read as a row would arrive as
 * pid 0.
 */
export function parsePlainTable(plain: string): PlainProcess[] {
  const rows: PlainProcess[] = [];
  for (const line of plain.split('\n')) {
    const match = PLAIN_ROW.exec(line.trimEnd());
    if (match === null) {
      continue;
    }
    const pid = Number(match[1]);
    const args = (match[7] ?? '').trim();
    if (!Number.isInteger(pid) || pid <= 0 || args === '') {
      continue;
    }
    const tty = match[5] ?? '??';
    const startedAt = Date.parse(match[6] ?? '');
    rows.push({
      pid,
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      uid: Number(match[4]),
      tty: tty === '??' || tty === '-' ? null : tty,
      startedAt: Number.isNaN(startedAt) ? null : startedAt,
      args,
    });
  }
  return rows;
}

/**
 * The plain listing joined with `ps -axwwE -o pid=,args=` into rows that carry
 * their environment.
 */
export function parseScan(plain: string, withEnv: string): ScannedProcess[] {
  const envLines = new Map<number, string>();
  for (const line of withEnv.split('\n')) {
    const match = ENV_ROW.exec(line.trimEnd());
    if (match !== null) {
      envLines.set(Number(match[1]), match[2] ?? '');
    }
  }
  return parsePlainTable(plain).map((row) => {
    const envLine = envLines.get(row.pid);
    return {
      ...row,
      env: envLine === undefined ? null : envSuffix(row.args, envLine),
    };
  });
}

/**
 * The environment half of a `ps -E` line, which prints the arguments and then
 * the environment with nothing but a space between them.
 *
 * Only what FOLLOWS the process's own arguments counts, so an argv that merely
 * mentions the tag (`grep GENIRO_RUN_ID=…`, the shell line that ran it) never
 * reads as carrying it. A line that does not start with those arguments — the
 * pid was recycled between the two listings — has no environment we can trust.
 * A line equal to them is a process whose environment the kernel withheld
 * (macOS does so for its own platform binaries).
 */
export function envSuffix(args: string, line: string): string | null {
  if (line === args) {
    return '';
  }
  return line.startsWith(`${args} `) ? line.slice(args.length + 1) : null;
}

/**
 * The run this environment's process was started for, when this geniro
 * started it — null for an untagged one, another geniro's, or one whose tag is
 * ambiguous (two different run ids: one of them sits inside another variable's
 * value, and which is not knowable from a space-joined listing).
 */
export function runTagOf(env: string, owner: string): string | null {
  const tokens = env.split(/\s+/);
  if (!tokens.includes(`${RUN_OWNER_ENV}=${owner}`)) {
    return null;
  }
  const prefix = `${RUN_ID_ENV}=`;
  const ids = new Set(
    tokens
      .filter((token) => token.startsWith(prefix))
      .map((token) => token.slice(prefix.length))
      .filter((id) => id.trim() !== ''),
  );
  return ids.size === 1 ? ([...ids][0] as string) : null;
}

/**
 * Whether a process is never any run's, whatever it carries: an executable of
 * the operating system or of an installed app, or the container VM.
 */
export function isOutsideAnyRun(args: string): boolean {
  const executable = args.split(/\s+/)[0] ?? '';
  return (
    SYSTEM_EXECUTABLE.test(executable) ||
    CONTAINER_VM.test(basename(executable)) ||
    CONTAINER_VM_DIRS.some((dir) => args.includes(dir))
  );
}

/**
 * Every process this geniro's runs own, by run id: each one whose environment
 * carries a run's tag, plus everything descending from it.
 *
 * This one answer is what the usage readout shows under a thread AND what that
 * thread's teardown stops, so the two can never disagree about a process.
 *
 * The descendants are not optional. A launcher that scrubs its children's
 * environment — turbo's strict env mode passes only its allowlist — leaves the
 * dev servers it starts untagged, while turbo itself carries the tag. A tagged
 * descendant belongs to its own tag's run, so each process lands in exactly
 * one run.
 *
 * What is never attributed is decided by structure, at any depth, and the walk
 * does not pass THROUGH it either:
 * - the daemon and every ancestor of it, pid 1 and below, another user's
 *   process; a run the daemon itself carries the tag of (this geniro was
 *   started from one of its own threads: its tree holds the app's window);
 * - a process on a terminal, with all it runs, while that terminal is open —
 *   the user's shell and their work in it;
 * - {@link isOutsideAnyRun}.
 */
export function attributeRunProcesses(
  rows: readonly ScannedProcess[],
  scope: AttributionScope,
): Map<string, ScannedProcess[]> {
  const tagOf = new Map<number, string>();
  for (const row of rows) {
    const runId = row.env === null ? null : runTagOf(row.env, scope.owner);
    if (runId !== null) {
      tagOf.set(row.pid, runId);
    }
  }

  const blocked = daemonChain(rows, scope.selfPid);
  const selfRuns = new Set<string>();
  for (const pid of blocked) {
    const runId = tagOf.get(pid);
    if (runId !== undefined) {
      selfRuns.add(runId);
    }
  }
  const byParent = new Map<number, ScannedProcess[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings) {
      siblings.push(row);
    } else {
      byParent.set(row.ppid, [row]);
    }
  }

  const fenced = fencedPids(rows, scope.uid, blocked, true);
  const eligible = (row: ScannedProcess): boolean =>
    row.pid > 1 && !blocked.has(row.pid) && !fenced.has(row.pid);

  const owned = new Map<string, ScannedProcess[]>();
  // `seen` across every walk: `ps` is no atomic snapshot, and a cycle in the
  // table would otherwise never end.
  const seen = new Set<number>();
  for (const root of rows) {
    const runId = tagOf.get(root.pid);
    if (runId === undefined || selfRuns.has(runId) || !eligible(root)) {
      continue;
    }
    if (seen.has(root.pid)) {
      continue;
    }
    seen.add(root.pid);
    const mine = owned.get(runId) ?? [];
    owned.set(runId, mine);
    const queue = [root];
    while (queue.length > 0) {
      const parent = queue.pop() as ScannedProcess;
      mine.push(parent);
      for (const child of byParent.get(parent.pid) ?? []) {
        if (seen.has(child.pid) || tagOf.has(child.pid) || !eligible(child)) {
          continue;
        }
        seen.add(child.pid);
        queue.push(child);
      }
    }
  }
  for (const procs of owned.values()) {
    procs.sort((a, b) => a.pid - b.pid);
  }
  return owned;
}

/** The daemon and every ancestor of it, launchd excluded. */
export function daemonChain(
  rows: readonly PlainProcess[],
  selfPid: number,
): Set<number> {
  const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]));
  const chain = new Set<number>();
  for (
    let pid: number | undefined = selfPid;
    pid !== undefined && pid > 1 && !chain.has(pid);
    pid = parentOf.get(pid)
  ) {
    chain.add(pid);
  }
  return chain;
}

/**
 * What no run may own, each with everything below it: another user's process,
 * one never any run's ({@link isOutsideAnyRun}) and, with `terminals`, one on a
 * terminal — the user's shell and what they run in it, only while that
 * terminal is open. The fence stops at `chain`, the daemon's own: geniro itself
 * is an installed app, and its agents are its children.
 *
 * Never the HOST of a terminal: an agent works on terminals too (codex runs
 * commands on a pseudo-terminal), and a whole agent must not vanish behind one.
 */
export function fencedPids(
  rows: readonly PlainProcess[],
  uid: number,
  chain: ReadonlySet<number>,
  terminals: boolean,
): Set<number> {
  const byParent = new Map<number, PlainProcess[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings) {
      siblings.push(row);
    } else {
      byParent.set(row.ppid, [row]);
    }
  }
  const fenceFrom = rows.filter(
    (row) =>
      row.pid > 1 &&
      !chain.has(row.pid) &&
      (row.uid !== uid ||
        isOutsideAnyRun(row.args) ||
        (terminals && row.tty !== null)),
  );
  const fenced = new Set<number>();
  while (fenceFrom.length > 0) {
    const row = fenceFrom.pop() as PlainProcess;
    if (fenced.has(row.pid)) {
      continue;
    }
    fenced.add(row.pid);
    for (const child of byParent.get(row.pid) ?? []) {
      if (!chain.has(child.pid)) {
        fenceFrom.push(child);
      }
    }
  }
  return fenced;
}

/** Over the cap the answer is to kill nothing, and to say what matched. */
export function capSelection(
  targets: ScannedProcess[],
  cap: number = RUN_PROCESS_CAP,
): RunProcessSelection {
  return targets.length > cap
    ? {
        targets: [],
        overCap: {
          count: targets.length,
          sample: targets.slice(0, OVER_CAP_SAMPLE),
        },
      }
    : { targets, overCap: null };
}
