import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Whether `binary` would be found and run: a path is checked as given, a bare
 * name against every `PATH` entry, the way a spawn resolves it.
 */
export function isExecutableOnPath(
  binary: string,
  path: string | undefined = process.env.PATH,
): boolean {
  const candidates = binary.includes('/')
    ? [binary]
    : (path ?? '')
        .split(delimiter)
        .filter((directory) => directory.length > 0)
        .map((directory) => join(directory, binary));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}
