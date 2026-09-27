import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';

import { Injectable, Optional } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import {
  type AttachmentMediaType,
  MAX_ATTACHMENT_BYTES,
} from '../../agents/chat.types';
import { isWithinDirectory } from '../../agents/utils/path-within';
import { TASK_UPLOAD_MAX_BYTES, type TaskAttachmentWire } from '../tasks.types';
import {
  removeTaskAttachments,
  taskAttachmentsRoot,
} from '../utils/task-attachments';

/** The image files {@link TaskAttachmentService.adopt} will copy onto a card. */
const ADOPTABLE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** The extension each media type is written under — never the caller's. */
const EXTENSIONS: Record<AttachmentMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * A picture pasted into a card's description, written where an AGENT can open
 * it.
 *
 * The gap it closes was reported plainly: "я всё ещё не могу вставлять файлы
 * или изображения… когда я делаю скриншот и нажимаю «Вставить», он должен
 * автоматически добавлять файл с description в Markdown. Сейчас ничего не
 * происходит." A description is the brief an agent works from, so a screenshot
 * in it has to survive as a FILE with a path — not as an inline `data:` URL,
 * which would be unreadable to the agent, would bloat every read of the row,
 * and would push a screenshot-sized string through the task's own PATCH.
 *
 * It writes under `<userData>/task-attachments/<taskId>/`, beside the chat
 * attachments and on the same reasoning (`AttachmentStoreService`): blobs stay
 * out of SQLite and the row carries only a reference. It is deliberately NOT
 * inside the project folder — a card's picture is geniro's own bookkeeping and
 * has no business appearing in the user's `git status`.
 *
 * The absolute path is what goes into the markdown, which is what makes this
 * work for both readers at once: the renderer resolves it through the task
 * image route, and the agent simply opens it.
 */
@Injectable()
export class TaskAttachmentService {
  private readonly root: string;

  constructor(
    /** Test seam only — nothing in the app passes it. */
    @Optional() root?: string,
  ) {
    this.root = root ?? taskAttachmentsRoot();
  }

  /**
   * Persist one image's base64 bytes and return the path to reference it by.
   *
   * The size is checked on the DECODED bytes rather than at the HTTP edge:
   * base64 inflates by ~4/3, so only this side knows the real figure — the
   * same rule the chat store states.
   */
  async save(
    taskId: string,
    mediaType: AttachmentMediaType,
    base64: string,
    name?: string,
  ): Promise<TaskAttachmentWire> {
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
        `attachment exceeds the ${Math.floor(
          MAX_ATTACHMENT_BYTES / 1024 / 1024,
        )}MB limit`,
      );
    }
    // The FILE name is minted here and never taken from the caller: a name
    // that crossed the wire could carry separators, and this one is joined
    // onto a path.
    const file = `${randomUUID()}.${EXTENSIONS[mediaType]}`;
    const dir = join(this.root, taskId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, file);
    await writeFile(path, bytes);
    return { path, name: markdownName(name) };
  }

  /**
   * Write one UPLOADED file under this card's own directory and return its
   * path — the phone's half of "Attach files".
   *
   * The desktop binds a file by PATH (`TaskFilesService.attach`), because it is
   * already on this machine. A phone has no path here to offer: the native
   * picker belongs to the Mac and is refused for a remote device, so the
   * button did nothing at all — REPORTED as "file attaching doesn't work on
   * mobile, nothing happens on click". The bytes are therefore stored where a
   * card's pictures already live, and the card then binds that path exactly as
   * it binds a picked one. Under a fresh uuid directory so the file keeps its
   * own name without two uploads of `notes.txt` colliding; the name is reduced
   * to its basename so it cannot climb out of that directory.
   */
  async store(taskId: string, name: string, base64: string): Promise<string> {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.byteLength === 0) {
      throw new BadRequestException(
        'ATTACHMENT_EMPTY',
        'the upload carried no decodable data',
      );
    }
    if (bytes.byteLength > TASK_UPLOAD_MAX_BYTES) {
      throw new BadRequestException(
        'ATTACHMENT_TOO_LARGE',
        `a file may be at most ${Math.floor(
          TASK_UPLOAD_MAX_BYTES / 1024 / 1024,
        )}MB`,
      );
    }
    // Control characters out (a NUL makes the write throw), and cut to the
    // 255 BYTES a file name may hold — the schema's 200 is characters, and
    // 200 multi-byte ones overrun it.
    const safeName = fitFileName(
      // eslint-disable-next-line no-control-regex -- stripping them is the point
      basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, ''),
    ).trim();
    if (safeName === '' || safeName === '.' || safeName === '..') {
      throw new BadRequestException(
        'ATTACHMENT_NAME_INVALID',
        `${name} is not a usable file name`,
      );
    }
    const dir = join(this.root, taskId, randomUUID());
    await mkdir(dir, { recursive: true });
    const path = join(dir, safeName);
    await writeFile(path, bytes);
    return path;
  }

  /**
   * COPY one image an agent referenced in its report onto the card, and return
   * the copy's path.
   *
   * A copy, where every other file on a card is a reference, and the reason is
   * who put the file there. A user attaches the archive they are working ON,
   * so a copy would go stale (`TaskFileSchema` argues that trade); an agent's
   * screenshot is written into its own scratch directory, which is routinely
   * under a temp root that is reaped — so a reference would be a dead link the
   * next week, on exactly the card whose report pointed at it. The copy lives
   * under this card's own directory, which a card delete already sweeps.
   *
   * Under a fresh uuid directory so the file keeps its OWN name — it is what the
   * card's file list shows — without two screenshots both called `shot.png`
   * colliding. The name is the source's basename, which carries no separator.
   */
  async adopt(taskId: string, source: string): Promise<string> {
    if (!isAbsolute(source)) {
      throw new BadRequestException(
        'ATTACHMENT_PATH_INVALID',
        `${source} is not an absolute path`,
      );
    }
    const extension = extname(source).slice(1).toLowerCase();
    if (!ADOPTABLE_EXTENSIONS.has(extension)) {
      throw new BadRequestException(
        'ATTACHMENT_NOT_AN_IMAGE',
        `${source} is not an image`,
      );
    }
    let found;
    try {
      found = await stat(source);
    } catch {
      throw new BadRequestException(
        'ATTACHMENT_NOT_FOUND',
        `no file at ${source}`,
      );
    }
    if (!found.isFile()) {
      throw new BadRequestException(
        'ATTACHMENT_NOT_A_FILE',
        `${source} is not a file`,
      );
    }
    if (found.size > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException(
        'ATTACHMENT_TOO_LARGE',
        `${source} exceeds the ${Math.floor(
          MAX_ATTACHMENT_BYTES / 1024 / 1024,
        )}MB limit`,
      );
    }
    const dir = join(this.root, taskId, randomUUID());
    await mkdir(dir, { recursive: true });
    const path = join(dir, basename(source));
    await copyFile(source, path);
    return path;
  }

  /**
   * Delete ONE file this service stored under a card, and the upload's own
   * directory with it once empty — or do nothing and answer false for any
   * path that is not inside that card's directory here.
   *
   * The bound is the whole safety argument, because the path it is handed is
   * read off a card's file list, and most entries on that list are the USER's
   * own files, referenced where they already lived: those must never be
   * touched. The path is normalized before the check (a `…/<task>/../../x`
   * would pass a bare prefix test and name a file anywhere), and the directory
   * holding it is checked again once its symlinks are resolved, since a link
   * planted inside the card's directory would otherwise aim the unlink at
   * wherever it points. Only the file is unlinked, never a tree.
   */
  async discard(taskId: string, path: string): Promise<boolean> {
    const own = join(this.root, taskId);
    // An id that is not ONE path segment (`..`, `a/b`, empty) would move the
    // bound itself somewhere else.
    if (dirname(own) !== join(this.root)) {
      return false;
    }
    const target = resolve(path);
    if (target === own || !isWithinDirectory(target, own)) {
      return false;
    }
    let realDir: string;
    let realOwn: string;
    try {
      [realDir, realOwn] = await Promise.all([
        realpath(dirname(target)),
        realpath(own),
      ]);
    } catch {
      // Nothing there to delete — the directory or the card's root is gone.
      return false;
    }
    if (!isWithinDirectory(realDir, realOwn)) {
      return false;
    }
    await rm(join(realDir, basename(target)), { force: true });
    // The per-upload uuid directory `store`/`adopt` made, when it is now
    // empty. `rmdir` refuses a directory that still holds anything, which is
    // exactly the condition wanted, and the card's own root is never removed
    // here — `removeTask` is what drops that.
    if (realDir !== realOwn) {
      await rmdir(realDir).catch(() => undefined);
    }
    return true;
  }

  /**
   * Drop every image pasted into one card.
   *
   * A card's screenshots are routinely a console, a token or a private
   * repository, and deleting the card left them on disk with nothing in the
   * app able to reach or remove them. `RunTeardownService` already does this
   * for a chat's attachments; a task's are the same bytes one column over.
   *
   * The work lives in `utils/task-attachments.ts`, so the board-delete path can
   * do the same thing without reaching across a module boundary for this
   * service.
   */
  removeTask(taskId: string): Promise<void> {
    return removeTaskAttachments(taskId, this.root);
  }
}

/**
 * The alt text a pasted picture is referenced under.
 *
 * A clipboard screenshot arrives with no name at all, so `Pasted image` is the
 * honest default; a real one keeps its own, minus the characters that would
 * end the markdown link early.
 */
function markdownName(name: string | undefined): string {
  const cleaned = (name ?? '').replace(/[[\]()\r\n]/g, '').trim();
  return cleaned === '' ? 'Pasted image' : cleaned;
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
