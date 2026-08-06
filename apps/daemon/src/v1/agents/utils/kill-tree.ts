/**
 * Signal a spawned child's ENTIRE process group (negative pid) so the tool/MCP
 * grandchildren a coding agent forks die with it — a single-PID kill would
 * orphan them. Falls back to the caller-supplied direct kill when the PID is
 * unavailable (a test fake) or the group is already gone. Never throws. Shared
 * by every daemon kill path (headless spawn-cli, PTY escalation) — extracted,
 * never mirrored.
 */
export function killProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: () => void,
): void {
  if (typeof pid === 'number' && pid > 0) {
    try {
      process.kill(-pid, signal); // negative pid → the whole process group
      return;
    } catch {
      // Group already exited, or the child never became a leader — fall
      // through to the best-effort direct kill.
    }
  }
  try {
    fallback();
  } catch {
    // Process already gone — nothing to kill.
  }
}

/**
 * Grace a process group gets between the SIGTERM that asks it to stop and the
 * SIGKILL that makes it.
 *
 * The window is what the user's own MCP servers shut down in. Every group this
 * daemon kills may hold them — a turn's group holds the ones its agent loaded,
 * and a listing probe's group holds the ones it launched to dial — so neither
 * kill path may skip straight to SIGKILL.
 */
export const GROUP_KILL_GRACE_MS = 2000;

/** The child shape a terminator needs — satisfied by `ChildProcess` and by a test fake. */
interface KillableChild {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface GroupTerminator {
  /**
   * SIGTERM the group, and arm the SIGKILL escalation if it is not already
   * armed. Safe to call repeatedly: the escalation is armed once.
   */
  terminate(): void;
  /** The process is accounted for — cancel a pending escalation. */
  disarm(): void;
}

/**
 * A SIGTERM → grace → SIGKILL escalation over a whole process group.
 *
 * Extracted rather than mirrored, because the two daemon paths that terminate a
 * group must not be able to disagree about it: the turn path (`spawn-cli`'s
 * `killGroup`) and the utility-listing path (`AgentAdapter.runAsProcessGroup`'s
 * reap). The listing path had no escalation at all and went straight to
 * SIGKILL, on a group whose whole purpose is to have launched the user's own
 * MCP servers.
 *
 * `isGone` lets a caller that KNOWS the process ended skip the force-kill —
 * without it, the escalation would signal a pid the OS may since have reissued.
 * A caller with no such signal omits it and always escalates, which is correct:
 * the SIGTERM either worked, in which case the group is empty and the SIGKILL
 * reaches nothing, or it did not, in which case the SIGKILL is the point.
 */
export function createGroupTerminator(
  child: KillableChild,
  options: { isGone?: () => boolean } = {},
): GroupTerminator {
  const isGone = options.isGone ?? (() => false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    terminate: () => {
      killProcessGroup(child.pid, 'SIGTERM', () => child.kill('SIGTERM'));
      if (timer) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        if (!isGone()) {
          killProcessGroup(child.pid, 'SIGKILL', () => child.kill('SIGKILL'));
        }
      }, GROUP_KILL_GRACE_MS);
      timer.unref?.();
    },
    disarm: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
