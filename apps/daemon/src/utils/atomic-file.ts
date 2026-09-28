import { renameSync, rmSync, writeFileSync } from 'node:fs';
import {
  link,
  open,
  readlink,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * How {@link atomicWrite} treats a file that already belongs to somebody else.
 *
 * Opt-in, because the default is right for every file the daemon OWNS (its
 * stores, its workflow library): a fresh file at the process umask. It is wrong
 * for a file another program owns and geniro merely edits — claude's
 * `~/.claude.json` is the case that needed it — where a rename-over quietly
 * rewrites three things that file's owner decided: its permission bits (a
 * 0600 file came back 0644, world-readable, holding the user's whole CLI
 * state), whether it was a symlink (a dotfiles-managed link was replaced by a
 * regular file), and whether the bytes were on disk before the old name was
 * given up.
 */
export interface AtomicWriteOptions {
  /**
   * Replace the file the way its owner writes it: keep the destination's own
   * permission bits (`fallbackMode` when there is no destination yet), and
   * write THROUGH a symlink at `path` — onto the file it names, staged beside
   * that file — rather than replacing the link.
   *
   * Transcribed from claude's own config writer (2.1.280, `CE(…, {mode: 0o600,
   * allowSymlink: true})`), which is the owner this exists for: it follows the
   * link, preserves the existing mode, and falls back to 0600.
   */
  preserveTarget?: { fallbackMode: number };
  /**
   * fsync the staged bytes before the rename, so a crash cannot leave the
   * destination renamed onto a file whose contents never reached the disk.
   */
  fsync?: boolean;
}

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
 *
 * `options` is for a file somebody ELSE owns — see {@link AtomicWriteOptions}.
 * Without it the behaviour is exactly what it always was.
 */
export async function atomicWrite(
  path: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const { preserveTarget, fsync = false } = options;
  // The destination the rename claims: the link's own target when the caller
  // asked for the owner's semantics, so the link survives and the staging file
  // sits on the target's filesystem, which is where the rename has to happen.
  const target =
    preserveTarget === undefined ? path : await writeTargetOf(path);
  const mode =
    preserveTarget === undefined
      ? undefined
      : await modeOf(target, preserveTarget.fallbackMode);
  const tmp = stagingPath(target);
  try {
    if (mode === undefined && !fsync) {
      await writeFile(tmp, content, 'utf8');
    } else {
      // `wx`: the name is unique to this process and call, so an existing file
      // there is somebody else's and must not be written through.
      const handle = await open(tmp, 'wx', mode ?? 0o666);
      try {
        await handle.writeFile(content, 'utf8');
        if (mode !== undefined) {
          // Again, explicitly: `open`'s mode is masked by the umask, so a 0644
          // umask would still hand a 0600 file back group- and world-readable.
          await handle.chmod(mode);
        }
        if (fsync) {
          await handle.sync();
        }
      } finally {
        await handle.close();
      }
    }
    await rename(tmp, target);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * The file a write to `path` should replace: `path` itself, or — when `path`
 * is a symlink — the file it names, so the link is kept.
 *
 * A DANGLING link is followed one level, as claude's own writer does, so the
 * write creates the file the link promises rather than replacing the link with
 * a regular file. Anything but "not there" is thrown: a path that cannot be
 * resolved for another reason (a loop, a permission) is not one to guess at.
 */
async function writeTargetOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
  try {
    const named = await readlink(path);
    return isAbsolute(named) ? named : resolve(dirname(path), named);
  } catch {
    return path;
  }
}

/** The permission bits of `path`, or `fallback` when there is no such file. */
async function modeOf(path: string, fallback: number): Promise<number> {
  try {
    return (await stat(path)).mode & 0o7777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }
    throw err;
  }
}

/**
 * Synchronous {@link atomicWrite}, for a caller that cannot yield before the
 * bytes are durable.
 *
 * The child journal is the reason it exists: it records a process group from
 * inside the spawn call itself, and the whole point of the record is to
 * survive a SIGKILL that could land on the very next tick. An awaited write
 * would leave a window in which a group is running and unrecorded — small, but
 * exactly the window the journal is meant to close.
 */
export function atomicWriteSync(path: string, content: string): void {
  const tmp = stagingPath(path);
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
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
