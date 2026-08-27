import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';

/**
 * Reads that treat an absent, unreadable or wrong-kind path as EMPTY rather
 * than as a failure.
 *
 * Every caller here is reading the user's OWN files — a CLI's config, a plugin
 * manifest, a skill directory — to enrich something the panel is already
 * waiting on. A missing directory or a file with the wrong permissions must
 * degrade one label, never fail the listing that carries it, so the try/catch
 * belongs at the read rather than at each of the dozen call sites.
 *
 * In `adapters/utils/` because it names no CLI: it is how a path is turned into
 * text, which is the same act whichever agent's file it is. Two byte-identical
 * copies had already grown — one private to `skill-scan.utils.ts`, one exported
 * from a cursor-named module as `readTextOrNull` — which is what a third
 * adapter needing the same read would have made a fourth.
 */

/** One file's contents, or null for absent, unreadable, or not a file. */
export async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** One directory's entries, or none for absent, unreadable, or not a directory. */
export async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
