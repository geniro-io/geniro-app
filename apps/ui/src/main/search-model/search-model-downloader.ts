import { createHash } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type { SearchModelFailureReason } from '../../shared/search-model';
import {
  DownloadHttpError,
  DownloadStalledError,
  downloadTo,
  fetchText,
  parseChecksums,
} from '../download';

/** One file of the pinned model. `source` names its path in the model repository; it is never fetched. */
export interface SearchModelFile {
  name: string;
  source: string;
  bytes: number;
  sha256: string;
}

/** The model this build pins: its release tag, its files and their digests. */
export interface SearchModelManifest {
  id: string;
  repo: string;
  revision: string;
  tag: string;
  dim: number;
  files: SearchModelFile[];
}

/** A model folder that has every file verified, as the daemon takes it (`EmbeddingModelRef`). */
export interface ReadyModel {
  id: string;
  revision: string;
  dim: number;
  dir: string;
}

export type SearchModelProgress = {
  phase: 'downloading' | 'checking';
  receivedBytes: number;
  totalBytes: number;
};

export interface SearchModelDownload {
  signal: AbortSignal;
  onProgress: (progress: SearchModelProgress) => void;
}

/**
 * The abort reasons a caller gives. Cancel discards the partial files; pausing
 * keeps them, so the next attempt resumes where this one stopped.
 */
export const DISCARD_PARTIALS = 'discard-partials';
export const PAUSE_DOWNLOAD = 'pause-download';

export const READY_FILE = 'ready.json';
const PART_SUFFIX = '.part';
const STALL_TIMEOUT_MS = 60_000;
const SPACE_MARGIN = 1.1;

const readyRecordSchema = z.object({
  id: z.string(),
  revision: z.string(),
  dim: z.number().int().positive(),
  files: z.array(z.string()),
});

export class SearchModelFailure extends Error {
  readonly reason: SearchModelFailureReason;

  constructor(reason: SearchModelFailureReason, message: string) {
    super(message);
    this.name = 'SearchModelFailure';
    this.reason = reason;
  }
}

export function modelFolderName(manifest: SearchModelManifest): string {
  return `${manifest.id}-${manifest.revision.slice(0, 7)}`;
}

export function totalBytesOf(manifest: SearchModelManifest): number {
  return manifest.files.reduce((sum, file) => sum + file.bytes, 0);
}

/**
 * Where the manifest's release assets are served from. A packaged app always
 * reads the pinned GitHub release; the override only exists for a dev build
 * exercising the download against `scripts/fetch-search-model.mjs --serve`.
 */
export function releaseBaseUrl(
  manifest: SearchModelManifest,
  options: { isPackaged: boolean; override: string | null },
): string {
  const base =
    !options.isPackaged && options.override !== null
      ? options.override
      : `https://github.com/geniro-io/geniro-app/releases/download/${manifest.tag}/`;
  return base.endsWith('/') ? base : `${base}/`;
}

export function failureReasonOf(err: unknown): SearchModelFailureReason {
  if (err instanceof SearchModelFailure) {
    return err.reason;
  }
  if (err instanceof DownloadHttpError) {
    return err.status === 404 ? 'not-published' : 'network';
  }
  if (err instanceof DownloadStalledError || err instanceof TypeError) {
    return 'network';
  }
  if (err instanceof Error && 'code' in err && err.code === 'ENOSPC') {
    return 'disk-full';
  }
  return 'unknown';
}

/** The folders under `modelsDir` that hold a complete copy of `id`, each with its revision. */
export async function readyModels(
  modelsDir: string,
  id: string,
): Promise<ReadyModel[]> {
  const found: ReadyModel[] = [];
  for (const name of await listDir(modelsDir)) {
    const dir = join(modelsDir, name);
    const record = await readReadyRecord(dir);
    if (record !== null && record.id === id) {
      found.push({ id, revision: record.revision, dim: record.dim, dir });
    }
  }
  return found;
}

/** Bytes of everything under `dir`; 0 when it does not exist. */
export async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await listEntries(dir)) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await dirBytes(path) : await sizeOf(path);
  }
  return total;
}

export interface SearchModelDownloaderOptions {
  /** The release base, ending in a slash. */
  baseUrl: string;
  /** `<userData>/models`. */
  modelsDir: string;
  /** Free bytes on the volume holding `dir`. Defaults to `statfs`. */
  availableBytes?: (dir: string) => Promise<number>;
  stallTimeoutMs?: number;
}

/**
 * Makes one manifest's folder hold every file, each verified against its size
 * and sha256, and then writes `ready.json`. A file already complete is kept as
 * it is; a partial one resumes. Only the folder this manifest names is touched.
 */
export class SearchModelDownloader {
  constructor(private readonly options: SearchModelDownloaderOptions) {}

  async download(
    manifest: SearchModelManifest,
    { signal, onProgress }: SearchModelDownload,
  ): Promise<string> {
    const dir = join(this.options.modelsDir, modelFolderName(manifest));
    try {
      await this.fetchAll(manifest, dir, signal, onProgress);
    } catch (err) {
      if (signal.aborted && signal.reason === DISCARD_PARTIALS) {
        await removePartials(dir);
      }
      throw err;
    }
    return dir;
  }

  private async fetchAll(
    manifest: SearchModelManifest,
    dir: string,
    signal: AbortSignal,
    onProgress: (progress: SearchModelProgress) => void,
  ): Promise<void> {
    const digests = parseChecksums(
      await fetchText(`${this.options.baseUrl}SHA256SUMS.txt`, signal),
    );
    for (const file of manifest.files) {
      if (digests.get(file.name) !== file.sha256) {
        throw new SearchModelFailure(
          'checksum',
          `SHA256SUMS.txt does not list ${file.name} with the digest the manifest pins`,
        );
      }
    }

    await mkdir(dir, { recursive: true });
    const total = totalBytesOf(manifest);
    onProgress({ phase: 'checking', receivedBytes: 0, totalBytes: total });
    let finished = 0;
    const pending: SearchModelFile[] = [];
    for (const file of manifest.files) {
      if (await isComplete(join(dir, file.name), file)) {
        finished += file.bytes;
      } else {
        pending.push(file);
      }
    }

    await this.checkSpace(dir, pending);

    for (const file of pending) {
      const part = join(dir, `${file.name}${PART_SUFFIX}`);
      const base = finished;
      const digest = await downloadTo(
        `${this.options.baseUrl}${encodeURIComponent(file.name)}`,
        part,
        {
          resume: true,
          stallTimeoutMs: this.options.stallTimeoutMs ?? STALL_TIMEOUT_MS,
          signal,
          onProgress: (progress) =>
            onProgress({
              phase: 'downloading',
              receivedBytes: base + progress.receivedBytes,
              totalBytes: total,
            }),
        },
      );
      if ((await sizeOf(part)) !== file.bytes || digest !== file.sha256) {
        await rm(part, { force: true });
        throw new SearchModelFailure(
          'checksum',
          `${file.name} did not match its checksum`,
        );
      }
      await rename(part, join(dir, file.name));
      finished += file.bytes;
    }

    onProgress({ phase: 'checking', receivedBytes: total, totalBytes: total });
    await writeReadyRecord(dir, manifest);
  }

  private async checkSpace(
    dir: string,
    pending: readonly SearchModelFile[],
  ): Promise<void> {
    let missing = 0;
    for (const file of pending) {
      missing +=
        file.bytes - (await sizeOf(join(dir, `${file.name}${PART_SUFFIX}`)));
    }
    if (missing <= 0) {
      return;
    }
    const available = await (this.options.availableBytes ?? freeBytesOf)(dir);
    if (available < missing * SPACE_MARGIN) {
      throw new SearchModelFailure(
        'disk-full',
        `${missing} bytes are still missing and ${available} are free`,
      );
    }
  }
}

async function readReadyRecord(dir: string) {
  let text: string;
  try {
    text = await readFile(join(dir, READY_FILE), 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) {
      return null;
    }
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = readyRecordSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

async function writeReadyRecord(
  dir: string,
  manifest: SearchModelManifest,
): Promise<void> {
  const record = {
    id: manifest.id,
    revision: manifest.revision,
    dim: manifest.dim,
    files: manifest.files.map((file) => file.name),
  };
  const tmp = join(dir, `${READY_FILE}.tmp`);
  await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
  await rename(tmp, join(dir, READY_FILE));
}

async function isComplete(
  path: string,
  file: SearchModelFile,
): Promise<boolean> {
  return (
    (await sizeOf(path)) === file.bytes &&
    (await sha256Of(path)) === file.sha256
  );
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function removePartials(dir: string): Promise<void> {
  for (const name of await listDir(dir)) {
    if (name.endsWith(PART_SUFFIX)) {
      await rm(join(dir, name), { force: true });
    }
  }
}

async function freeBytesOf(dir: string): Promise<number> {
  const { bavail, bsize } = await statfs(dir);
  return bavail * bsize;
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) {
      return 0;
    }
    throw err;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if (isErrno(err, 'ENOENT')) {
      return [];
    }
    throw err;
  }
}

async function listEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isErrno(err, 'ENOENT')) {
      return [];
    }
    throw err;
  }
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}
