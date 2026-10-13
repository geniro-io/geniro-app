import { execFile } from 'node:child_process';

/**
 * How long a listing may take before it is abandoned. `ps` on a busy laptop
 * answers in single-digit milliseconds; anything near this is a machine in
 * trouble, and no readout or reap is worth waiting longer for.
 */
const PS_TIMEOUT_MS = 4_000;

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * One `ps` read, or null when it failed, timed out or overflowed.
 *
 * Always under the C locale: `lstart` is printed in the user's language
 * (`вторник, 13 октября 2026 г.`) and `%cpu` in their decimal format, and a
 * parser that skips what it cannot read would turn a Russian or German locale
 * into an empty process table without a word.
 */
export function runPs(
  args: readonly string[],
  maxBuffer: number = DEFAULT_MAX_BUFFER,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      [...args],
      {
        timeout: PS_TIMEOUT_MS,
        maxBuffer,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (error, out) => resolve(error ? null : out),
    );
  });
}
