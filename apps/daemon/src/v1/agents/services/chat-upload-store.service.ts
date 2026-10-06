import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';

import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import { environment } from '../../../environments';
import { CHAT_UPLOAD_MAX_BYTES, type ChatUploadWire } from '../chat.types';

/** Constructor options — test seams, not user config. */
export interface ChatUploadStoreOptions {
  /** Uploads root (test seam); default `<userData>/chat-uploads`. */
  root?: string;
}

const UUID_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * A file a PHONE attached to a chat message, written where the agent can open
 * it — the composer's paperclip, for a device that has no path on this machine.
 *
 * On the Mac the paperclip writes a picked file's own PATH into the message,
 * the way a pasted file already does: the file is here, and a copy would go
 * stale. A phone has none to offer — a browser never hands a page a file's
 * path, and the native picker belongs to the Mac — so its bytes are stored
 * under `<userData>/chat-uploads/<uuid>/<name>` and the composer writes THAT
 * path into the message instead. The agent then reads it like any other file.
 *
 * Not under a run: the landing composer has no run yet when the file is
 * picked, and the path has to be in the text before the message is sent. The
 * upload is collected instead by the run whose user messages NAME it
 * ({@link ChatUploadStoreService.removeReferenced}, called from the run's
 * teardown), so it lives exactly as long as the conversation that uses it.
 *
 * Under a fresh uuid directory so the file keeps its OWN name — it is what the
 * agent reads in the message — without two uploads of `notes.txt` colliding;
 * the name is reduced to its basename so it cannot climb out of that
 * directory. `TaskAttachmentService.store` is the card's twin of this.
 */
@Injectable()
export class ChatUploadStoreService {
  private readonly root: string;

  constructor(options: ChatUploadStoreOptions = {}) {
    this.root = options.root ?? join(environment.userDataDir, 'chat-uploads');
  }

  /**
   * Write one uploaded file and answer with the path to put in the message.
   *
   * The size is checked on the DECODED bytes: base64 inflates by ~4/3, so only
   * this side knows the real figure.
   */
  async store(name: string, base64: string): Promise<ChatUploadWire> {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.byteLength === 0) {
      throw new BadRequestException(
        'UPLOAD_EMPTY',
        'the upload carried no decodable data',
      );
    }
    if (bytes.byteLength > CHAT_UPLOAD_MAX_BYTES) {
      throw new BadRequestException(
        'UPLOAD_TOO_LARGE',
        `a file may be at most ${Math.floor(
          CHAT_UPLOAD_MAX_BYTES / 1024 / 1024,
        )}MB`,
      );
    }
    // Control characters out (a NUL makes the write throw), separators out by
    // taking the basename, then cut to the 255 BYTES a file name may hold.
    const safeName = fitFileName(
      // eslint-disable-next-line no-control-regex -- stripping them is the point
      basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, ''),
    ).trim();
    if (safeName === '' || safeName === '.' || safeName === '..') {
      throw new BadRequestException(
        'UPLOAD_NAME_INVALID',
        `${name} is not a usable file name`,
      );
    }
    const dir = join(this.root, randomUUID());
    await mkdir(dir, { recursive: true });
    const path = join(dir, safeName);
    await writeFile(path, bytes);
    return { path, name: safeName, bytes: bytes.byteLength };
  }

  /**
   * Delete every upload the given message texts name, and answer how many.
   *
   * A run's teardown hands over its users' messages: an upload is reachable
   * only through the text that names it, so the run whose messages carry the
   * path is the one that owns it. Only a `<root>/<uuid>/` directory this
   * service minted can match — the uuid shape is part of the pattern, so no
   * text can point the delete anywhere else. Best-effort: a directory already
   * gone is a success.
   */
  async removeReferenced(texts: readonly string[]): Promise<number> {
    const pattern = new RegExp(
      `${escapeRegExp(this.root + sep)}(${UUID_SOURCE})(?=${escapeRegExp(sep)})`,
      'g',
    );
    const ids = new Set<string>();
    for (const text of texts) {
      for (const match of text.matchAll(pattern)) {
        ids.add(match[1]!);
      }
    }
    await Promise.all(
      [...ids].map((id) =>
        rm(join(this.root, id), { recursive: true, force: true }),
      ),
    );
    return ids.size;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A file name cut to the 255 bytes a file system allows, extension kept. */
function fitFileName(name: string): string {
  const limit = 255;
  if (Buffer.byteLength(name) <= limit) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  let stem = dot > 0 ? name.slice(0, dot) : name;
  while (stem.length > 0 && Buffer.byteLength(stem + extension) > limit) {
    stem = stem.slice(0, -1);
  }
  return stem + extension;
}
