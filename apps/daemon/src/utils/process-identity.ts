import { execFileSync } from 'node:child_process';

/**
 * "Is pid N still the process I recorded?" — the one identity primitive the
 * daemon has for a process it does not own a handle to.
 *
 * A bare `kill(pid, 0)` liveness check is NOT enough for anything that then
 * SIGKILLs: macOS recycles pids (they wrap at ~99998), so a recorded pid can
 * belong to an unrelated process — a user's own editor, their own interactive
 * `claude` — by the time we read it back. Both readers here act on the answer
 * by killing a whole process GROUP or by refusing to boot, so a wrong answer is
 * expensive in both directions.
 *
 * The discriminator is the kernel's own start time for that pid, compared to
 * the timestamp we recorded when we spawned (or when we took the lock). `ps`
 * reports it to one-second resolution, so an exact match is impossible; the
 * tolerance below is what makes the comparison usable without making it loose.
 */

/**
 * How far a probed start time may sit from the recorded one and still count as
 * the same process.
 *
 * `ps -o lstart` has one-second resolution and we record `Date.now()` either
 * side of the spawn syscall, so the true delta is sub-second — this is
 * rounding slack, not a guess. It must stay small: the window is the ONLY
 * thing standing between a recycled pid and a SIGKILL aimed at whatever now
 * holds it, and a recycled pid would have to have started within this window
 * of the original to be confused with it.
 */
export const PROCESS_IDENTITY_TOLERANCE_MS = 2_000;

/** Reads each live pid's start time (epoch ms). A test seam. */
export type StartTimeProbe = (pids: number[]) => Map<number, number>;

/**
 * Start times for whichever of `pids` are alive right now, from `ps`.
 *
 * Synchronous on purpose: both callers run at boot, before the server listens,
 * where an await buys nothing and an unhandled rejection would cost the reap.
 *
 * A pid that is not alive is simply absent from the map — `ps` exits non-zero
 * when NONE of the requested pids exist, which is a normal empty answer here
 * and not a failure. A line whose timestamp will not parse is dropped rather
 * than guessed at: an unparseable start time must read as "cannot confirm
 * identity", which every caller treats as "leave it alone".
 */
export const readProcessStartTimes: StartTimeProbe = (pids) => {
  const started = new Map<number, number>();
  if (pids.length === 0) {
    return started;
  }
  const batched = probe(pids);
  if (batched !== null) {
    return parseStartTimes(batched, started);
  }
  // The batch was REJECTED, not empty — `ps` validates every id it is given
  // and fails the whole invocation on one it dislikes ("process id too
  // large"), so a single unusable entry would otherwise hide every live pid
  // beside it and the reap would silently do nothing. Ask one at a time
  // instead; a journal holds a handful of entries, so the cost is a handful of
  // spawns on a path that runs once per boot.
  for (const pid of pids) {
    const single = probe([pid]);
    if (single !== null) {
      parseStartTimes(single, started);
    }
  }
  return started;
};

/** One `ps` read, or null when it refused to answer at all. */
function probe(pids: number[]): string | null {
  try {
    return execFileSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Non-zero exit: none of the requested pids is alive, or `ps` rejected the
    // request. Indistinguishable here, and handled by the caller either way.
    return null;
  }
}

function parseStartTimes(
  output: string,
  started: Map<number, number>,
): Map<number, number> {
  for (const line of output.split('\n')) {
    // `<pid> <Www Mmm DD HH:MM:SS YYYY>` — split on the FIRST run of spaces
    // only, because `lstart` itself contains spaces (and pads single-digit
    // days to two columns).
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    const pid = match?.[1];
    const lstart = match?.[2];
    if (pid === undefined || lstart === undefined) {
      continue;
    }
    const parsed = Date.parse(lstart);
    if (Number.isNaN(parsed)) {
      continue;
    }
    started.set(Number(pid), parsed);
  }
  return started;
}

/**
 * Whether `pid` is alive AND is still the process that was recorded as having
 * started at `recordedStartedAt`.
 *
 * False covers both "gone" and "cannot confirm" — the two cases a caller must
 * treat identically, because acting on an unconfirmed identity is exactly the
 * mistake this module exists to prevent.
 */
export function isSameProcess(
  pid: number,
  recordedStartedAt: number,
  startTimes: ReadonlyMap<number, number>,
  toleranceMs: number = PROCESS_IDENTITY_TOLERANCE_MS,
): boolean {
  const actual = startTimes.get(pid);
  if (actual === undefined) {
    return false;
  }
  return Math.abs(actual - recordedStartedAt) <= toleranceMs;
}
