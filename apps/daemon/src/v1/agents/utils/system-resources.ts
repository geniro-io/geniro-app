import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';

const SYSCTL_TIMEOUT_MS = 4_000;

/** The volume user data and swap live on; `/` is the read-only system volume. */
const DATA_VOLUMES = ['/System/Volumes/Data', '/'] as const;

/**
 * macOS's memory pressure level (`kern.memorystatus_vm_pressure_level`):
 * 1 normal, 2 warning, 4 critical. Null when it could not be read.
 */
export function readMemoryPressureLevel(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'sysctl',
      ['-n', 'kern.memorystatus_vm_pressure_level'],
      { timeout: SYSCTL_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } },
      (error, out) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(parsePressureLevel(out));
      },
    );
  });
}

export function parsePressureLevel(out: string): number | null {
  const text = out.trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

/** Bytes an unprivileged process may still write to the Data volume, or null. */
export async function readFreeDiskBytes(): Promise<number | null> {
  for (const path of DATA_VOLUMES) {
    try {
      const info = await statfs(path);
      return Number(info.bavail) * Number(info.bsize);
    } catch {
      continue;
    }
  }
  return null;
}
