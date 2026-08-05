import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

/**
 * A temp directory that removes itself when the spec file finishes.
 *
 * Specs that reach the filesystem need a real directory, and `mkdtempSync`
 * makes one per call — but nothing removes it, so every `pnpm test:unit` left
 * a fresh pile behind: 170 `claude-empty-*` directories had accumulated in
 * `$TMPDIR` from one spec alone. A per-run leak is invisible and permanent,
 * which is the worst combination.
 *
 * The `afterAll` is registered by IMPORTING this module — vitest binds a
 * top-level hook to the file that imported it — so a spec gets cleanup by
 * using the helper and cannot forget the other half of the pair.
 *
 * Removal is forced and recursive: a spec that deliberately leaves an
 * unreadable or partly-written tree behind must still be cleaned up, and a
 * directory a test already removed itself is not an error.
 */
const created: string[] = [];

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
