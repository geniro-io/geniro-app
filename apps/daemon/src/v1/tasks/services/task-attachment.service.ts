import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable, Optional } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import { environment } from '../../../environments';
import {
  type AttachmentMediaType,
  MAX_ATTACHMENT_BYTES,
} from '../../agents/chat.types';
import type { TaskAttachmentWire } from '../tasks.types';

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
    this.root = root ?? join(environment.userDataDir, 'task-attachments');
  }

  /**
   * Persist one image's base64 bytes and return the path to reference it by.
   *
   * The size is checked on the DECODED bytes rather than at the HTTP edge:
   * base64 inflates by ~4/3, so only this side knows the real figure — the
   * same rule the chat store states.
   */
  save(
    taskId: string,
    mediaType: AttachmentMediaType,
    base64: string,
    name?: string,
  ): TaskAttachmentWire {
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
    mkdirSync(dir, { recursive: true });
    const path = join(dir, file);
    writeFileSync(path, bytes);
    return { path, name: markdownName(name) };
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
