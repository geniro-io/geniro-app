import { link, rename, unlink, writeFile } from 'node:fs/promises';

/**
 * Per-process counter behind the staging file name. Two concurrent writers
 * sharing one `${path}.tmp` would interleave their content and race the
 * commit, so every stage gets a name no other writer will ever pick.
 */
let tmpSeq = 0;

/** The staging path a commit writes before it claims `path`. */
function stagingPath(path: string): string {
  return `${path}.${process.pid}.${tmpSeq++}.tmp`;
}

/**
 * Write `content` to `path` atomically: stage to a unique tmp file, then
 * rename over the destination. A reader sees either the previous file or the
 * new one, never a half-written mix, so a crash mid-write cannot corrupt a
 * store the daemon reads on its next launch.
 *
 * The write sits INSIDE the try so a failed stage (disk full, EACCES) still
 * cleans up its partial tmp; the unique name means nothing else could ever
 * reclaim a stray. After a successful rename the unlink is an ENOENT no-op.
 *
 * `path`'s directory must already exist, and the tmp file is created beside
 * the destination on purpose — rename is only atomic within one filesystem.
 */
export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
  const tmp = stagingPath(path);
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Exclusive sibling of {@link atomicWrite}: stage to a unique tmp file, then
 * hard-link it to the final path. `link` fails with EEXIST when the name is
 * already taken — the exclusivity a plain rename would lose — while still
 * never exposing a half-written file, which a direct `wx` write would.
 */
export async function atomicCreate(
  path: string,
  content: string,
): Promise<void> {
  const tmp = stagingPath(path);
  try {
    await writeFile(tmp, content, 'utf8');
    await link(tmp, path);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
