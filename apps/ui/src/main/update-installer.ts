import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import type { LatestRelease } from './updater';

/**
 * Replace this app's own bundle with a newer release.
 *
 * The sequence is `scripts/install.sh`'s, moved in-process so the app can do it
 * itself: download the release zip, verify it against the published
 * SHA256SUMS.txt, unpack with `ditto`, swap the `.app` and strip quarantine.
 * Nothing here decides WHEN — that is `update-service.ts`.
 *
 * Two rules the shape of this file exists to enforce:
 *
 * 1. **A missing checksum is a refusal, not a warning.** The app is signed but
 *    not notarized, so Gatekeeper validates nothing on the way in and the
 *    running app validates nothing on the way out. The published digest is the
 *    only link
 *    between the release that was built and the code about to execute as the
 *    user. `install.sh` degrades to TLS-only with a warning because a human is
 *    watching it; nobody is watching this.
 * 2. **The old bundle is moved aside, never deleted first.** Every failure
 *    after that point puts it back, so an update that dies mid-copy costs the
 *    user a message rather than their installed app.
 */

const execFileAsync = promisify(execFile);

/** Absolute paths — these run as this user, and PATH is not ours to trust. */
const DITTO = '/usr/bin/ditto';
const XATTR = '/usr/bin/xattr';

/** A download is a ~150MB transfer; a check's 10s budget makes no sense here. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/**
 * Removing a freshly-written `.app` tree races macOS itself.
 *
 * REPORTED: `ENOTEMPTY: directory not empty, rmdir '…/update-1eJcO3/unpacked/
 * Geniro.app/Contents/Resources'`. A bundle that has just been unpacked into
 * Application Support is exactly what Spotlight's importers open, and a file
 * appearing under a directory between its own emptying and its `rmdir` is what
 * that error IS. `fs.rm` retries precisely this class (EBUSY / EMFILE / ENFILE /
 * ENOTEMPTY / EPERM) when asked to, and asks for nothing by default —
 * `maxRetries` is 0.
 *
 * Retrying is the cheap half of the fix. The half that matters is that a
 * cleanup failure is not an install failure at all — see {@link discard}.
 */
const RM_RETRIES = 5;
const RM_RETRY_DELAY_MS = 100;

/**
 * How many deletions are currently running with asar support switched off.
 *
 * `process.noAsar` is a single global flag, and the sweep deletes its trees
 * concurrently — so the first one to finish must not switch the flag back on
 * under the others. Counted rather than set-and-restore per call for exactly
 * that reason.
 */
let asarSuspended = 0;

/**
 * Run a filesystem deletion with Electron's asar support switched OFF.
 *
 * MEASURED, electron 42.5.1 vs node 24.14.0, on a tree holding one 111KB
 * `app.asar`:
 *
 * | runtime  | `lstat(app.asar).isDirectory()` | `fs.rm(tree, {recursive})` |
 * |----------|---------------------------------|----------------------------|
 * | node     | `false`                         | resolved in **1ms**        |
 * | electron | `true`                          | **still running at 30s**   |
 *
 * That difference is the whole bug. Electron patches `fs` so a path INSIDE an
 * archive resolves — which is what makes `require('…/app.asar/main.js')` work —
 * and the archive itself therefore stats as a directory. `fs.rm({recursive})`
 * believes it, walks into the archive's virtual contents, and tries to unlink
 * tens of thousands of entries that do not exist on disk, retrying each one
 * {@link RM_RETRIES} times with a backoff. It does not fail; it does not
 * finish.
 *
 * REPORTED as an update that installs "бесконечно" — the loader never ends. It
 * never ended because {@link installUpdate}'s cleanup never returned, so the
 * install never resolved and the phase never left `installing`, on an update
 * whose bundle was already swapped in and working. The same call in the launch
 * sweep is why a user had `Geniro.app.old-*` eroded down to exactly its two
 * `.asar` files: every real file around them was deleted, and the walk then
 * disappeared into the archive.
 *
 * Node-environment tests cannot see any of this — the UI suite runs under node,
 * where the same code is the 1ms row. So the pin in the spec is on the FLAG,
 * which is the part that behaves identically in both.
 */
async function withoutAsar<T>(run: () => Promise<T>): Promise<T> {
  if (asarSuspended++ === 0) {
    process.noAsar = true;
  }
  try {
    return await run();
  } finally {
    if (--asarSuspended === 0) {
      process.noAsar = false;
    }
  }
}

/** `fs.rm`, with this file's retry policy and no asar layer under it. */
function removeTree(path: string): Promise<void> {
  return withoutAsar(() =>
    rm(path, {
      recursive: true,
      force: true,
      maxRetries: RM_RETRIES,
      retryDelay: RM_RETRY_DELAY_MS,
    }),
  );
}

/**
 * The two names an update writes beside the things it is replacing.
 *
 * Declared once because they are read by two parties that must agree: the code
 * that CREATES them ({@link installUpdate}'s `mkdtemp`, {@link swapBundle}'s
 * backup) and the code that later finds them again to remove them
 * ({@link sweepUpdateDebris}). A prefix that drifts on one side is a sweeper
 * that silently stops matching anything — which is exactly how four dead trees
 * came to sit in a user's Application Support and beside their app.
 */
const SCRATCH_PREFIX = 'update-';
const BACKUP_SUFFIX = '.old-';

/**
 * The caller's abandon signal and this step's own budget, as one signal.
 *
 * Both are real: a download has 15 minutes whatever the caller does, and the
 * caller can give up sooner (the service's watchdog, when nothing has moved for
 * long enough). `AbortSignal.any` is what makes the pair a single thing every
 * `fetch` and `execFile` below can take.
 */
function withDeadline(ms: number, signal?: AbortSignal): AbortSignal {
  const budget = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, budget]) : budget;
}

/**
 * Delete a tree we own, and never let the deletion be the thing that fails.
 *
 * Every caller here is removing scratch AFTER the outcome is already decided:
 * the new bundle is in place, or the old one has been put back. Left to throw,
 * this step turned a completed update into "The update could not be installed"
 * — the reported error, on an update that had already succeeded, which then
 * skipped the relaunch and left the user on the old code with the new app
 * beside it. Leftovers cost disk; a false failure costs the feature.
 *
 * Answers whether the tree is actually GONE, because one caller reports what it
 * removed and a swallowed failure would otherwise be reported as a removal.
 */
async function discard(path: string): Promise<boolean> {
  try {
    await removeTree(path);
    return true;
  } catch {
    return false;
  }
}

/** How the caller is told about a running download. */
export interface InstallProgress {
  /** 0–1, or null while the server has not declared a length. */
  fraction: number | null;
  receivedBytes: number;
  totalBytes: number | null;
}

/**
 * Which half of the install is running.
 *
 * The download reports a fraction; the unpack-and-swap cannot (`ditto` gives no
 * progress), so it says only that it has started — a bar frozen at 100% for the
 * half-minute a 150MB copy takes reads as a hung update.
 */
export type InstallStage = 'downloading' | 'installing';

export interface InstallInput {
  release: LatestRelease;
  /** The `.app` to replace — {@link resolveBundlePath} of this process. */
  bundlePath: string;
  /** A scratch directory the app owns (under userData). */
  workDir: string;
  /**
   * Abandon the install.
   *
   * The service arms a watchdog over every non-terminal phase, and abandoning
   * has to mean CANCELLED rather than merely ignored: a caller that stopped
   * listening while a swap was still running could otherwise be talked into
   * starting a second one over the top of the first. Aborting mid-swap is safe
   * for the same reason every other failure there is — `ditto` rejects, and the
   * backup is renamed back.
   */
  signal?: AbortSignal;
  onStage?: (stage: InstallStage) => void;
  onProgress?: (progress: InstallProgress) => void;
}

/**
 * The `.app` bundle a running executable belongs to, or null if it is not in
 * one.
 *
 * `process.execPath` inside a packaged app is
 * `…/Geniro.app/Contents/MacOS/Geniro`, so the bundle is three levels up. A
 * translocated path is refused outright: macOS runs a quarantined app from a
 * read-only synthesised mount under `/private/var/folders/.../AppTranslocation`,
 * and "updating" that copy would write to a volume that vanishes at quit while
 * the real app on disk stayed exactly as it was — a silent no-op the user
 * would see as an update that keeps coming back.
 */
export function resolveBundlePath(execPath: string): string | null {
  if (execPath.includes('/AppTranslocation/')) {
    return null;
  }
  const bundle = resolve(execPath, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

/**
 * Can this process replace that bundle?
 *
 * Both the bundle and its parent are checked: the swap renames the old one
 * aside (needs write on the PARENT) and copies the new one in (likewise), and a
 * bundle owned by another account — an app installed by a different user, or by
 * `sudo` — fails on the bundle itself. Answered up front so the UI can offer
 * the brew command instead of an Update button that would fail at the last step.
 */
export async function canWriteBundle(bundlePath: string): Promise<boolean> {
  try {
    await access(dirname(bundlePath), constants.W_OK);
    await access(bundlePath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `shasum -a 256` output into name → digest.
 *
 * The format is `<64 hex>  <name>` per line (two spaces, or ` *` in binary
 * mode). Anything that does not match that is skipped rather than throwing —
 * the file is allowed to carry entries for assets this app never downloads.
 */
export function parseChecksums(text: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (m) {
      digests.set(m[2]!.trim(), m[1]!.toLowerCase());
    }
  }
  return digests;
}

/** Fetch a text asset (the checksum file). */
async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'geniro-app' },
    signal: withDeadline(60_000, signal),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${basename(url)}`);
  }
  return res.text();
}

/**
 * Stream a URL to disk, reporting progress, and return the sha256 of what was
 * actually written.
 *
 * Hashed on the way through rather than by re-reading the file: the bytes that
 * were written are exactly the bytes that were hashed, so nothing can be
 * swapped underneath between the two.
 */
async function downloadTo(
  url: string,
  dest: string,
  onProgress?: (progress: InstallProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'geniro-app' },
    signal: withDeadline(DOWNLOAD_TIMEOUT_MS, signal),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading ${basename(url)}`);
  }
  if (!res.body) {
    throw new Error('the download returned no body');
  }
  const declared = Number(res.headers.get('content-length'));
  const totalBytes =
    Number.isFinite(declared) && declared > 0 ? declared : null;

  const hash = createHash('sha256');
  let receivedBytes = 0;
  const source = Readable.fromWeb(
    res.body as Parameters<typeof Readable.fromWeb>[0],
  );
  source.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    receivedBytes += chunk.length;
    onProgress?.({
      fraction: totalBytes ? Math.min(receivedBytes / totalBytes, 1) : null,
      receivedBytes,
      totalBytes,
    });
  });
  await pipeline(source, createWriteStream(dest));
  return hash.digest('hex');
}

/**
 * Scratch directories a previous install left behind.
 *
 * Named-prefix only ({@link SCRATCH_PREFIX}, the `mkdtemp` template below), so
 * this can never reach anything else that shares the work directory.
 * Best-effort by construction: an unreadable work dir is a fresh install's
 * normal state.
 */
async function staleScratch(workDir: string): Promise<string[]> {
  const entries = await readdir(workDir).catch(() => [] as string[]);
  return entries
    .filter((name) => name.startsWith(SCRATCH_PREFIX))
    .map((name) => join(workDir, name));
}

/**
 * Bundle backups a previous swap left beside the app.
 *
 * Matched on `<the app's own name>.old-`, so it can only ever name something
 * this file wrote: `Geniro.app` does not start with `Geniro.app.old-`, and
 * neither does anything else a user keeps in /Applications.
 */
async function staleBackups(bundlePath: string): Promise<string[]> {
  const parent = dirname(bundlePath);
  const prefix = `${basename(bundlePath)}${BACKUP_SUFFIX}`;
  const entries = await readdir(parent).catch(() => [] as string[]);
  return entries
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(parent, name));
}

/**
 * Remove everything a previous update left on disk, and say what was removed.
 *
 * Both halves of the mess, because a user had all four kinds at once: two
 * scratch trees under `updates/` and two `Geniro.app.old-*` backups beside the
 * app, ~224MB of it, from updates that had SUCCEEDED days earlier. Neither is a
 * leak in the install sequence — the scratch is discarded in a `finally` and
 * the backup on the way out of {@link swapBundle} — but both removals are
 * deliberately best-effort ({@link discard} swallows), and macOS holding a
 * freshly-written bundle open is exactly the case that makes them fail. So the
 * guarantee cannot live inside the install at all: it is a sweep at LAUNCH,
 * which is the one moment nothing here is running.
 *
 * The returned paths are what the caller logs. A sweep that removes nothing is
 * the normal case and returns an empty array.
 */
export async function sweepUpdateDebris({
  workDir,
  bundlePath,
}: {
  workDir: string;
  /** The `.app` being updated — its backups live beside it. */
  bundlePath: string;
}): Promise<string[]> {
  const [scratch, backups] = await Promise.all([
    staleScratch(workDir),
    staleBackups(bundlePath),
  ]);
  const paths = [...scratch, ...backups];
  const gone = await Promise.all(paths.map(discard));
  // What was REMOVED, not what was attempted. The caller logs this line, and it
  // is the only record a user has of the sweep — a path it names while the
  // directory is still sitting there turns the one diagnostic into a reason to
  // look somewhere else.
  return paths.filter((_, i) => gone[i]);
}

/**
 * Download, verify and swap in `release`.
 *
 * Resolves once the new bundle is in place; the caller relaunches. Everything
 * it wrote is cleaned up on both paths — a failed update must not leave a
 * gigabyte of half-downloaded release in the user's Application Support.
 */
export async function installUpdate({
  release,
  bundlePath,
  workDir,
  signal,
  onStage,
  onProgress,
}: InstallInput): Promise<void> {
  if (!release.checksums) {
    throw new Error(
      `release v${release.version} publishes no SHA256SUMS.txt — refusing to install a download nothing can verify`,
    );
  }
  if (!(await canWriteBundle(bundlePath))) {
    throw new Error(`${bundlePath} is not writable by this user`);
  }

  await mkdir(workDir, { recursive: true });
  // Whatever an earlier run could not delete. `discard` swallows its own
  // failure, which is right — but only because the next install sweeps up
  // after it, or a directory macOS was holding open for a second would sit in
  // Application Support with a release zip in it for good.
  await Promise.all((await staleScratch(workDir)).map(discard));
  const scratch = await mkdtemp(join(workDir, SCRATCH_PREFIX));
  try {
    const expected = parseChecksums(
      await fetchText(release.checksums.url, signal),
    ).get(release.zip.name);
    if (!expected) {
      throw new Error(
        `SHA256SUMS.txt carries no entry for ${release.zip.name}`,
      );
    }

    const archive = join(scratch, release.zip.name);
    onStage?.('downloading');
    const actual = await downloadTo(
      release.zip.url,
      archive,
      onProgress,
      signal,
    );
    if (actual !== expected) {
      throw new Error(
        `checksum mismatch for ${release.zip.name} — the download does not match the published release`,
      );
    }

    onStage?.('installing');
    // `ditto -x -k` is what unpacks a macOS app archive with its symlinks,
    // resource forks and permissions intact; `unzip` flattens some of them.
    const unpacked = join(scratch, 'unpacked');
    await execFileAsync(DITTO, ['-x', '-k', archive, unpacked], { signal });
    const staged = join(unpacked, basename(bundlePath));
    await access(staged, constants.F_OK);

    // The last cheap place to stop. Past this line the app is briefly absent
    // from its own path, so an abandoned attempt costs a rollback rather than
    // nothing.
    signal?.throwIfAborted();
    await swapBundle(staged, bundlePath, signal);
  } finally {
    await discard(scratch);
  }
}

/**
 * Put `staged` where `bundlePath` is, keeping the old one until the new one is
 * fully in place.
 *
 * The rename is the commit point. Before it, nothing has changed; after it, the
 * app is briefly absent from its own path, so the copy that follows is the one
 * failure worth undoing — and it is undone by renaming the original back, which
 * cannot itself fail for any reason the rename out did not already catch.
 *
 * Removing the old bundle LAST, and only on success, is deliberate: the running
 * process keeps its open handles (the asar archive is read through an fd that
 * an unlink does not close), so this is safe while the app is still up, but it
 * is also the step with nothing left to protect.
 */
async function swapBundle(
  staged: string,
  bundlePath: string,
  signal?: AbortSignal,
): Promise<void> {
  const backup = `${bundlePath}${BACKUP_SUFFIX}${process.pid}`;
  // This one is BEFORE the commit point, so a failure here is a genuine refusal
  // to start — renaming onto a leftover would be the destructive kind of
  // surprise. It still retries, for the reason `discard` documents, and it
  // still runs under {@link withoutAsar}: a leftover backup is a bundle, so
  // this is the same walk-into-the-archive hang, one step earlier.
  await removeTree(backup);
  await rename(bundlePath, backup);
  try {
    await execFileAsync(DITTO, [staged, bundlePath], { signal });
  } catch (err) {
    await rename(backup, bundlePath);
    throw err;
  }
  // The archive was fetched by this process rather than by a browser, so it
  // carries no quarantine bit — but a future download path might, and the app
  // has no notarization ticket to clear one with. Failure is
  // swallowed for the same reason install.sh's is: nothing to strip is the
  // normal case.
  await execFileAsync(XATTR, ['-dr', 'com.apple.quarantine', bundlePath]).catch(
    () => undefined,
  );
  // AFTER the commit point: the new bundle is already in place, so failing to
  // remove the old one cannot be allowed to report the update as failed.
  await discard(backup);
}
