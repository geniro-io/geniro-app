import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';

import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import {
  type AttachmentMediaType,
  type LocalImageWire,
  MAX_LOCAL_IMAGE_BYTES,
} from '../chat.types';
import { RunDao } from '../dao/run.dao';

/** File extension → the media type a data URL must declare for it. */
const IMAGE_EXTENSIONS: Record<string, AttachmentMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * A file on disk an agent referenced from its own markdown, read back for the
 * transcript to display.
 *
 * The gap this closes: an agent that produces a chart, a diagram or a
 * screenshot says so the only way markdown can — `![shot](/tmp/shots/x.png)` —
 * and the renderer showed a broken image every time. Two independent reasons,
 * both of which this route is the answer to. The renderer's CSP is
 * `img-src 'self' data:`, so a `file:` src is refused outright; and a RELATIVE
 * reference (`![](a.png)`, the other form measured in the author's own history)
 * resolves against the app's own origin, which has nothing to do with the
 * folder the agent was working in.
 *
 * **Not confined to the run's cwd**, and that is deliberate rather than an
 * oversight. Both forms the author's own `geniro.db` actually contains are
 * `/tmp/shots/…` — outside any project folder — so a containment rule would
 * refuse the real case while calling itself security. It would also be
 * protecting nothing: the reference was written BY the agent, which already
 * reads the user's disk with the user's own privileges, and the bytes travel
 * to a renderer whose CSP forbids sending them anywhere. What IS enforced is
 * what keeps this an image channel rather than a file-read channel — a known
 * image extension, a real regular file, and a size ceiling — so a path naming
 * something else is refused before it is opened.
 */
@Injectable()
export class LocalImageService {
  constructor(private readonly runs: RunDao) {}

  /**
   * Read one referenced image as base64.
   *
   * A relative path is resolved against the RUN's cwd — the folder the agent
   * was working in when it wrote the reference — which is the only base under
   * which `![](a.png)` means anything.
   */
  async read(runId: string, path: string): Promise<LocalImageWire> {
    const trimmed = path.trim();
    if (trimmed === '') {
      throw new BadRequestException(
        'IMAGE_PATH_EMPTY',
        'no image path was given',
      );
    }
    // A URL is not this route's business, and answering one would turn a
    // filesystem read into a fetch the local-first constraint forbids. The
    // renderer refuses these before asking; this is the second door.
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      throw new BadRequestException(
        'IMAGE_PATH_NOT_LOCAL',
        `${trimmed} is not a path on this machine`,
      );
    }
    const mediaType = IMAGE_EXTENSIONS[extname(trimmed).toLowerCase()];
    if (mediaType === undefined) {
      throw new BadRequestException(
        'IMAGE_TYPE_UNSUPPORTED',
        `${trimmed} is not one of ${Object.keys(IMAGE_EXTENSIONS).join(', ')}`,
      );
    }
    const absolute = isAbsolute(trimmed)
      ? trimmed
      : resolve(await this.cwdOf(runId), trimmed);

    let real: string;
    try {
      // Canonicalized before the stat, so the size and the file-kind checks and
      // the read all decide about the SAME file — a symlink swapped between
      // them would otherwise be checked as one thing and read as another.
      real = realpathSync(absolute);
    } catch {
      throw new NotFoundException('IMAGE_NOT_FOUND', `no file at ${absolute}`);
    }
    const stat = statSync(real);
    if (!stat.isFile()) {
      throw new BadRequestException(
        'IMAGE_NOT_A_FILE',
        `${absolute} is not a file`,
      );
    }
    if (stat.size > MAX_LOCAL_IMAGE_BYTES) {
      throw new BadRequestException(
        'IMAGE_TOO_LARGE',
        `${absolute} is larger than the ${Math.floor(
          MAX_LOCAL_IMAGE_BYTES / 1024 / 1024,
        )}MB display limit`,
      );
    }
    return {
      path: trimmed,
      mediaType,
      data: readFileSync(real).toString('base64'),
    };
  }

  /**
   * The folder a relative reference is measured from.
   *
   * A missing run is a 404 rather than a silent fall back to the daemon's own
   * cwd: resolving against whatever directory the daemon happens to have been
   * started in would read a file the agent never named.
   */
  private async cwdOf(runId: string): Promise<string> {
    const run = await this.runs.getById(runId);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run ${runId}`);
    }
    // A run's cwd is nullable on the row, and a relative reference has nothing
    // to be measured from without one. Refused rather than guessed: falling
    // back to the daemon's own working directory would read whatever file
    // happened to sit there under the agent's name for it.
    if (run.cwd === null) {
      throw new BadRequestException(
        'IMAGE_PATH_RELATIVE',
        `run ${runId} has no working directory, so a relative image path cannot be resolved`,
      );
    }
    return run.cwd;
  }
}
