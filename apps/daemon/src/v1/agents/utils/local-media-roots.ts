import { tmpdir } from 'node:os';

/** `/tmp` is named literally: where the system temp directory IS `/tmp`, the two would be one entry. */
export function systemMediaRoots(): string[] {
  return ['/tmp', tmpdir()];
}

export function localMediaRoots(runFolder: string | null): string[] {
  return runFolder === null
    ? systemMediaRoots()
    : [...systemMediaRoots(), runFolder];
}
