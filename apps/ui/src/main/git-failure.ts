/**
 * The one line of a failed git call worth showing a user.
 *
 * Not stderr's FIRST line: git writes progress there before it fails —
 * `worktree add` opens with "Preparing worktree (checking out '…')" and only
 * then prints the `fatal:` that says why — so the first line reads like a
 * status message and hides the cause. The first `fatal:`/`error:` line is the
 * cause; without one, the last line git wrote is the nearest thing to it.
 *
 * `fallback` when the failure carries no stderr at all (git missing, a
 * timeout's kill, a non-exec error).
 */
export function gitFailureLine(error: unknown, fallback: string): string {
  const stderr =
    error instanceof Error && 'stderr' in error
      ? String((error as { stderr: unknown }).stderr)
      : '';
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return (
    lines.find((line) => /^(fatal|error):/.test(line)) ??
    lines.at(-1) ??
    fallback
  );
}
