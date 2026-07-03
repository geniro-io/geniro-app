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
