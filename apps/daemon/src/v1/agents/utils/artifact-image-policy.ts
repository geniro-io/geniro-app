import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BadRequestException, NotFoundException } from '@packages/common';

import {
  ARTIFACT_IMAGE_MEDIA_TYPE,
  type ArtifactImageExtension,
  type ArtifactImageMediaType,
} from './artifact-html-images';
import { isWithinDirectory } from './path-within';

/** The largest single image one published page may reference. */
export const MAX_ARTIFACT_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * The most image bytes one published page may show in total. A picture counts
 * each time the page shows it: the served page carries every reference in full,
 * so this is what bounds the frame, however many references there are.
 */
export const MAX_ARTIFACT_PAGE_IMAGE_BYTES = 64 * 1024 * 1024;

/** The most distinct images one published page may hold. */
export const MAX_ARTIFACT_PAGE_IMAGES = 64;

/** One image a page may show, as read from disk and identified by its bytes. */
export interface ArtifactImage {
  readonly extension: ArtifactImageExtension;
  readonly mediaType: ArtifactImageMediaType;
  readonly bytes: Buffer;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** A size in megabytes, to one decimal place, as it reads in a message. */
export function megabytes(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(1));
}

/**
 * The path a page's image source names on this machine: a `file:` address as the
 * path it stands for, anything else as written, trimmed. An address that does not
 * parse is kept as written, and then fails the absolute-path check.
 */
export function localPathOf(src: string): string {
  const trimmed = src.trim();
  if (!/^file:/i.test(trimmed)) {
    return trimmed;
  }
  try {
    return fileURLToPath(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Reads one local image a page refers to, or refuses it with the reason.
 *
 * The type is decided by the file's first bytes, never its name: a text file
 * renamed `.png` is not an image, and an image renamed `.dat` is. Containment is
 * judged on the path as written first, and then on the REAL path after links are
 * followed, so a symlink inside an allowed folder that leads out of it is refused
 * like any path outside. A hard link is refused outright, because its contents can
 * live outside the folders even when its name does not.
 *
 * A refusal for a path outside the folders is the same whether or not the file
 * exists, so a model learns nothing about the machine from what it is refused.
 * The file is opened without blocking and then checked as an open file, so a FIFO
 * or device swapped in after the path was judged cannot stall the reader.
 *
 * `allowedRoots` are the folders an artifact may draw from. Each is judged as
 * written and in its canonical form; a root that does not exist is not a root.
 */
export function readArtifactImage(
  path: string,
  allowedRoots: readonly string[],
): ArtifactImage {
  judgeImagePath(path, allowedRoots);
  const real = realPathOf(path);
  if (containingRoot(real, allowedRoots) === null) {
    throw outsideFolders(path);
  }
  const fd = openForReading(path, real);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new BadRequestException(
        'IMAGE_NOT_A_FILE',
        `${path} is not a file`,
      );
    }
    // Judged on the open file, so a second link made after the path was read is seen too.
    if (stat.nlink > 1) {
      throw new BadRequestException(
        'IMAGE_SHARED_FILE',
        `${path} is a hard link, so its contents may live outside the allowed folders`,
      );
    }
    if (stat.size > MAX_ARTIFACT_IMAGE_BYTES) {
      throw tooLarge(path, stat.size);
    }
    const bytes = readFileSync(fd);
    if (bytes.byteLength > MAX_ARTIFACT_IMAGE_BYTES) {
      throw tooLarge(path, bytes.byteLength);
    }
    const extension = sniff(bytes);
    if (extension === null) {
      throw new BadRequestException(
        'IMAGE_TYPE_UNSUPPORTED',
        `${path} is not a png, jpeg, webp, gif or avif image`,
      );
    }
    return {
      extension,
      mediaType: ARTIFACT_IMAGE_MEDIA_TYPE[extension],
      bytes,
    };
  } finally {
    closeSync(fd);
  }
}

/** Whether the path, normalised, lies in a root as written or in its canonical form. */
function lexicallyWithin(path: string, roots: readonly string[]): boolean {
  const target = resolve(path);
  return roots.some((root) => {
    if (isWithinDirectory(target, resolve(root))) {
      return true;
    }
    const canonical = realOrNull(root);
    return canonical !== null && isWithinDirectory(target, canonical);
  });
}

/**
 * Refuses a path that is not absolute, or that lies outside the allowed folders as
 * written. Judged before anything reads the file system, so the refusal does not
 * depend on whether the file exists. Exported because the store must judge each
 * reference BEFORE it consults any memo of references it already read: a memo keyed
 * by the real file would otherwise accept a link from outside the folders.
 */
export function judgeImagePath(path: string, roots: readonly string[]): void {
  if (!isAbsolute(path)) {
    throw new BadRequestException(
      'IMAGE_PATH_NOT_ABSOLUTE',
      `${path} is not an absolute path, and an artifact cannot resolve a relative image path`,
    );
  }
  if (!lexicallyWithin(path, roots)) {
    throw outsideFolders(path);
  }
}

/**
 * The real path of a picture, or the refusal. A path that names no file is
 * IMAGE_NOT_FOUND; any other failure to resolve it is IMAGE_UNREADABLE with the
 * system's code, so the agent is told the real cause rather than "no file".
 */
function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new NotFoundException('IMAGE_NOT_FOUND', `no file at ${path}`);
    }
    throw new BadRequestException(
      'IMAGE_UNREADABLE',
      `${path} cannot be read (${String(code ?? 'unknown error')})`,
    );
  }
}

/** The first allowed root the real path sits inside, canonicalized, or null. */
function containingRoot(real: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    const canonical = realOrNull(root);
    if (canonical !== null && isWithinDirectory(real, canonical)) {
      return canonical;
    }
  }
  return null;
}

/**
 * Opens the real path read-only and without blocking, and refuses a link planted
 * after the path was judged. A FIFO opens at once and is refused as not a file,
 * where a plain read of it would wait for a writer that never comes.
 */
function openForReading(path: string, real: string): number {
  try {
    return openSync(
      real,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new NotFoundException('IMAGE_NOT_FOUND', `no file at ${path}`);
    }
    throw new BadRequestException(
      'IMAGE_UNREADABLE',
      `${path} cannot be read (${String(code ?? 'unknown error')})`,
    );
  }
}

function outsideFolders(path: string): BadRequestException {
  return new BadRequestException(
    'IMAGE_OUTSIDE_ALLOWED_FOLDERS',
    `${path} is outside the folders an artifact may draw images from`,
  );
}

function tooLarge(path: string, bytes: number): BadRequestException {
  return new BadRequestException(
    'IMAGE_TOO_LARGE',
    `${path} is ${megabytes(bytes)} MB, over the ${megabytes(MAX_ARTIFACT_IMAGE_BYTES)} MB per-image limit`,
  );
}

/** The real path a file resolves to, or null when there is none. */
export function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * The format a file's leading bytes declare, or null for anything else. WebP and
 * AVIF are RIFF and ISO-BMFF containers, so their brand sits at a fixed offset
 * rather than at the start.
 */
function sniff(bytes: Buffer): ArtifactImageExtension | null {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  const head = bytes.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) {
    return 'gif';
  }
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') {
    return 'webp';
  }
  if (
    head.slice(4, 8) === 'ftyp' &&
    (head.slice(8, 12) === 'avif' || head.slice(8, 12) === 'avis')
  ) {
    return 'avif';
  }
  return null;
}
