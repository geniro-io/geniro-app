import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_ATTACHMENT_BYTES } from '../../agents/chat.types';
import { TaskAttachmentService } from './task-attachment.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('TaskAttachmentService', () => {
  let root: string;
  let service: TaskAttachmentService;

  beforeAll(() => {
    // The constructor's own documented test seam — a real temp directory so
    // nothing here touches the userData dir `taskAttachmentsRoot()` would
    // otherwise resolve to.
    root = mkdtempSync(join(tmpdir(), 'geniro-task-attach-'));
    service = new TaskAttachmentService(root);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses base64 that decodes to nothing', async () => {
    let code: string | undefined;
    try {
      await service.save(randomUUID(), 'image/png', '!!!!');
    } catch (err) {
      code = (err as { errorCode?: string }).errorCode;
    }
    expect(code).toBe('ATTACHMENT_EMPTY');
  });

  it('refuses an image past the size cap — the DECODED bytes, never the wire string', async () => {
    // base64 inflates by ~4/3, which is the whole reason this guard lives
    // here rather than as a bound on the zod string: a base64 payload can sit
    // comfortably under a byte cap on the WIRE and still decode to something
    // over MAX_ATTACHMENT_BYTES.
    const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64');
    let code: string | undefined;
    try {
      await service.save(randomUUID(), 'image/png', huge);
    } catch (err) {
      code = (err as { errorCode?: string }).errorCode;
    }
    expect(code).toBe('ATTACHMENT_TOO_LARGE');
  });

  it('strips a `]` and `(` from the name so the alt text cannot close early', async () => {
    // LOAD-BEARING: the returned name is written straight into markdown as
    // `![name](path)`. An unstripped `]` closes the alt-text bracket early,
    // and everything after it — including the `(path)` that was meant to be
    // the link target — is read as plain text instead, so the injected image
    // reference silently stops being one.
    const saved = await service.save(
      randomUUID(),
      'image/png',
      PNG.toString('base64'),
      'a](b).png',
    );

    // The exact result, not merely the absence of `](` — that proxy still
    // passes with a stray `(` left in the name (`a]b(.png`), which reopens
    // the alt-text bracket the very next markdown reference closes.
    expect(saved.name).toBe('ab.png');
  });

  it('names an unnamed paste "Pasted image"', async () => {
    const saved = await service.save(
      randomUUID(),
      'image/png',
      PNG.toString('base64'),
    );

    expect(saved.name).toBe('Pasted image');
  });

  it('writes a real file under <root>/<taskId>/ whose bytes round-trip, and returns that absolute path', async () => {
    const taskId = randomUUID();

    const saved = await service.save(
      taskId,
      'image/png',
      PNG.toString('base64'),
      'shot.png',
    );

    expect(dirname(saved.path)).toBe(join(root, taskId));
    expect(readFileSync(saved.path).equals(PNG)).toBe(true);
  });
});
