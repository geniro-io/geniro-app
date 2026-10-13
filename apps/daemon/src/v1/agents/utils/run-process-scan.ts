import { basename } from 'node:path';

/**
 * The env var every run-scoped agent CLI is spawned with, carrying its RUN id.
 * Every descendant inherits it — a dev server the agent detached with `nohup`
 * and that launchd adopted included — which is how a deleted thread's
 * processes are found once nothing the daemon holds points at them any more.
 */
export const RUN_ID_ENV = 'GENIRO_RUN_ID';

/**
 * The most processes one run's teardown will signal. A real run's dev stands,
 * watchers and browsers come to a few dozen; a selection past this is a filter
 * that matched something it should not, and the answer is to kill nothing.
 */
export const RUN_PROCESS_CAP = 250;

/** One process, as the two `ps` listings the scan joins describe it. */
export interface ScannedProcess {
  pid: number;
  ppid: number;
  uid: number;
  /** Kernel start time (epoch ms) — null when `ps` printed one that will not parse. */
  startedAt: number | null;
  args: string;
  /**
   * The environment, space-joined as `ps -E` prints it — null when it could
   * not be told apart from the arguments (see {@link envSuffix}).
   */
  env: string | null;
}

/** What a teardown is about to signal, or why it signals nothing. */
export interface RunProcessSelection {
  targets: ScannedProcess[];
  /** What matched when that was over the cap — null when it was not. */
  overCap: { count: number; sample: ScannedProcess[] } | null;
}

/** How many of an over-cap match the warning names. */
const OVER_CAP_SAMPLE = 10;

/** Executables under these are the system's or an installed app's, never a run's. */
const PROTECTED_PATH_PREFIXES = ['/Applications/', '/System/', '/usr/libexec/'];

/**
 * The container VM and its tooling. One VM serves every project on the
 * machine, so killing it — even one this run's agent happened to start —
 * takes down every other session's containers.
 */
const PROTECTED_NAME =
  /^(colima|lima|limactl|qemu|qemu-[\w.-]+|docker|docker-[\w.-]+|com\.docker\.[\w.-]+)$/i;
const PROTECTED_PATH_PARTS = ['/.colima/', '/.lima/', '/_lima/'];

// `lstart` is five fields with a space-padded day: `Mon Oct  5 17:34:22 2026`.
const PLAIN_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;
const ENV_ROW = /^\s*(\d+) (.*)$/;

/**
 * Join `ps -axww -o pid=,ppid=,uid=,lstart=,args=` with
 * `ps -axwwE -o pid=,args=` into rows that carry their environment.
 *
 * A line of either listing that does not open the way it was asked to is
 * skipped rather than guessed at — this is another program's output, and a
 * header read as a row would arrive as pid 0.
 */
export function parseScan(plain: string, withEnv: string): ScannedProcess[] {
  const envLines = new Map<number, string>();
  for (const line of withEnv.split('\n')) {
    const match = ENV_ROW.exec(line.trimEnd());
    if (match !== null) {
      envLines.set(Number(match[1]), match[2] ?? '');
    }
  }
  const rows: ScannedProcess[] = [];
  for (const line of plain.split('\n')) {
    const match = PLAIN_ROW.exec(line.trimEnd());
    if (match === null) {
      continue;
    }
    const pid = Number(match[1]);
    const args = (match[5] ?? '').trim();
    if (!Number.isInteger(pid) || pid <= 0 || args === '') {
      continue;
    }
    const startedAt = Date.parse(match[4] ?? '');
    const envLine = envLines.get(pid);
    rows.push({
      pid,
      ppid: Number(match[2]),
      uid: Number(match[3]),
      startedAt: Number.isNaN(startedAt) ? null : startedAt,
      args,
      env: envLine === undefined ? null : envSuffix(args, envLine),
    });
  }
  return rows;
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

/** Whether an environment carries exactly this run's tag. */
export function carriesRunTag(env: string, runId: string): boolean {
  return env.split(/\s+/).includes(`${RUN_ID_ENV}=${runId}`);
}

/** Whether a process is one no teardown may ever signal, whatever it carries. */
export function isProtectedProcess(args: string): boolean {
  const tokens = args.split(/\s+/);
  const executable = tokens[0] ?? '';
  if (PROTECTED_PATH_PREFIXES.some((prefix) => executable.startsWith(prefix))) {
    return true;
  }
  if (PROTECTED_PATH_PARTS.some((part) => args.includes(part))) {
    return true;
  }
  return tokens.some((token) => PROTECTED_NAME.test(basename(token)));
}

/**
 * The processes a run's teardown signals: every one whose environment carries
 * the run's tag, plus everything descending from them.
 *
 * The descendants are not optional. A launcher that scrubs its children's
 * environment — turbo's strict env mode passes only its allowlist — leaves the
 * dev servers it starts untagged, while turbo itself carries the tag.
 *
 * Never selected, at any depth: the daemon and every ancestor of it, pid 1 and
 * below, another user's process, and {@link isProtectedProcess}. The walk does
 * not pass THROUGH any of those either, so a tagged ancestor of the daemon can
 * never reach the daemon's other runs, and an excluded process's children are
 * not this run's to judge.
 */
export function selectRunProcesses(
  rows: readonly ScannedProcess[],
  scope: { runId: string; selfPid: number; uid: number; cap?: number },
): RunProcessSelection {
  if (scope.runId.trim() === '') {
    return { targets: [], overCap: null };
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const blocked = new Set<number>();
  for (
    let pid: number | undefined = scope.selfPid;
    pid !== undefined && pid > 1 && !blocked.has(pid);
    pid = byPid.get(pid)?.ppid
  ) {
    blocked.add(pid);
  }
  const eligible = (row: ScannedProcess): boolean =>
    row.pid > 1 &&
    row.uid === scope.uid &&
    !blocked.has(row.pid) &&
    !isProtectedProcess(row.args);

  const byParent = new Map<number, ScannedProcess[]>();
  for (const row of rows) {
    byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
  }
  const selected = new Map<number, ScannedProcess>();
  const queue = rows.filter(
    (row) =>
      eligible(row) && row.env !== null && carriesRunTag(row.env, scope.runId),
  );
  for (const root of queue) {
    selected.set(root.pid, root);
  }
  // Iterative with a `seen` set: `ps` is no atomic snapshot, and a cycle in
  // the table would otherwise never end.
  while (queue.length > 0) {
    const parent = queue.pop() as ScannedProcess;
    for (const child of byParent.get(parent.pid) ?? []) {
      if (selected.has(child.pid) || !eligible(child)) {
        continue;
      }
      selected.set(child.pid, child);
      queue.push(child);
    }
  }
  const targets = [...selected.values()];
  const cap = scope.cap ?? RUN_PROCESS_CAP;
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
