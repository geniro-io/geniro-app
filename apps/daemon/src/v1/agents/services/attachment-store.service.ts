import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { environment } from '../../../environments';
import {
  type AttachmentMediaType,
  type AttachmentWire,
  MAX_ATTACHMENT_BYTES,
  MAX_LOCAL_IMAGE_BYTES,
} from '../chat.types';

/** `<userData>/` directory the attachments live in, one folder per run. */
export const ATTACHMENTS_DIR_NAME = 'attachments';

/** Constructor options — test seams, not user config. */
export interface AttachmentStoreOptions {
  /** Attachments root (test seam); default `<userData>/attachments`. */
  root?: string;
}

/** The file extension each accepted media type is stored under. */
const EXTENSIONS: Record<AttachmentMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ATTACHMENT_ID = new RegExp(
  `^${UUID.source.slice(1, -1)}\\.(png|jpg|gif|webp)$`,
);

/**
 * Images the user attached to a chat message, stored as files under
 * `<userData>/attachments/<runId>/`.
 *
 * They are files rather than SQLite rows on purpose: the storage split keeps
 * blobs out of the database, and both delivery paths want a file anyway — the
 * claude adapter reads the bytes back for a base64 content block, and any CLI
 * without a structured input channel can only be handed a path.
 *
 * The id is a fresh UUID, never anything derived from caller input, so the
 * `runId`/`id` pair a read route is given cannot escape the attachments root
 * by traversal: both halves are validated against the shapes this service
 * itself minted.
 */
@Injectable()
export class AttachmentStoreService {
  private readonly root: string;

  constructor(options: AttachmentStoreOptions = {}) {
    this.root =
      options.root ?? join(environment.userDataDir, ATTACHMENTS_DIR_NAME);
  }

  /**
   * Persist one image's base64 bytes and return the row that goes in the
   * message payload. Rejects an oversize image here rather than at the HTTP
   * edge: base64 inflates by ~4/3, so the decoded size is the real limit and
   * only this side knows it.
   */
  save(
    runId: string,
    mediaType: AttachmentMediaType,
    base64: string,
  ): AttachmentWire {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.byteLength === 0) {
      throw new BadRequestException(
        'ATTACHMENT_EMPTY',
        'attachment carried no decodable image data',
      );
    }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException(
        'ATTACHMENT_TOO_LARGE',
        `attachment exceeds the ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit`,
      );
    }
    return { id: this.write(runId, mediaType, bytes).id, mediaType };
  }

  /**
   * Persist an image geniro obtained itself — a gallery picture downloaded
   * from a URL — and answer its absolute path. It lives and dies with the run
   * like an attachment; the caller has already bounded its size.
   */
  saveDownloaded(
    runId: string,
    mediaType: AttachmentMediaType,
    bytes: Buffer,
  ): string {
    if (!UUID.test(runId)) {
      throw new BadRequestException('RUN_ID_INVALID', 'not a run id');
    }
    if (bytes.byteLength > MAX_LOCAL_IMAGE_BYTES) {
      throw new BadRequestException(
        'ATTACHMENT_TOO_LARGE',
        `a downloaded image may be at most ${Math.floor(MAX_LOCAL_IMAGE_BYTES / 1024 / 1024)}MB`,
      );
    }
    return this.write(runId, mediaType, bytes).path;
  }

  /**
   * Delete downloaded images {@link saveDownloaded} wrote for a run, and the
   * run's directory once it is empty. Only a file directly in that directory
   * with a name this service mints is touched, whatever the caller passes.
   */
  removeDownloaded(runId: string, paths: readonly string[]): void {
    if (!UUID.test(runId)) {
      return;
    }
    const dir = join(this.root, runId);
    for (const path of paths) {
      const id = path.slice(dir.length + 1);
      if (dirname(path) === dir && ATTACHMENT_ID.test(id)) {
        rmSync(path, { force: true });
      }
    }
    if (existsSync(dir) && readdirSync(dir).length === 0) {
      rmdirSync(dir);
    }
  }

  private write(
    runId: string,
    mediaType: AttachmentMediaType,
    bytes: Buffer,
  ): { id: string; path: string } {
    const id = `${randomUUID()}.${EXTENSIONS[mediaType]}`;
    const dir = join(this.root, runId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, id);
    writeFileSync(path, bytes);
    return { id, path };
  }

  /**
   * Delete every attachment of one run, and the run's directory with them.
   *
   * Lives here, beside `save`, because this service is the only thing that
   * knows the layout — a caller composing `join(userData, 'attachments', id)`
   * itself would be a second place that has to be right. The run id is matched
   * against the shape this service mints before anything is removed, so a
   * `..` segment can never make this recurse out of the attachments root.
   *
   * Best-effort and idempotent: a run that never had an attachment has no
   * directory, and that is a success, not an error.
   */
  removeRun(runId: string): void {
    if (!UUID.test(runId)) {
      return;
    }
    rmSync(join(this.root, runId), { recursive: true, force: true });
  }

  /**
   * Absolute path of a stored attachment — what an adapter hands its CLI.
   *
   * Both halves are matched against the shapes this service itself mints (a
   * UUID run id, a `<uuid>.<ext>` attachment id) before they are joined. Every
   * read reaches the filesystem through here, so a `..` segment arriving from
   * a route param cannot walk out of the attachments root and hand back an
   * arbitrary file the daemon can read.
   */
  pathOf(runId: string, id: string): string {
    if (!UUID.test(runId) || !ATTACHMENT_ID.test(id)) {
      throw new NotFoundException('ATTACHMENT_NOT_FOUND', 'no such attachment');
    }
    return join(this.root, runId, id);
  }

  /**
   * The stored bytes plus the media type its extension encodes. The mapping
   * lives here, next to the one that chose the extension, so a new accepted
   * type cannot be added to storage without being readable back.
   */
  read(
    runId: string,
    id: string,
  ): { mediaType: AttachmentMediaType; bytes: Buffer } {
    const path = this.pathOf(runId, id);
    const extension = id.slice(id.lastIndexOf('.') + 1);
    const mediaType = (Object.keys(EXTENSIONS) as AttachmentMediaType[]).find(
      (type) => EXTENSIONS[type] === extension,
    );
    if (!mediaType) {
      throw new NotFoundException('ATTACHMENT_NOT_FOUND', 'no such attachment');
    }
    try {
      return { mediaType, bytes: readFileSync(path) };
    } catch {
      throw new NotFoundException('ATTACHMENT_NOT_FOUND', 'no such attachment');
    }
  }
}
