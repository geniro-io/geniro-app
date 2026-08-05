import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { tempDir } from '../__tests__/temp-dir';
import { MAX_ATTACHMENT_BYTES } from '../chat.types';
import { AttachmentStoreService } from './attachment-store.service';

const RUN = '11111111-2222-3333-4444-555555555555';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('AttachmentStoreService', () => {
  let root: string;
  let store: AttachmentStoreService;

  beforeEach(() => {
    root = tempDir('attachments-');
    store = new AttachmentStoreService({ root });
  });

  it('round-trips the bytes it stored', () => {
    const saved = store.save(RUN, 'image/png', PNG.toString('base64'));

    const read = store.read(RUN, saved.id);

    expect(read.bytes.equals(PNG)).toBe(true);
    expect(read.mediaType).toBe('image/png');
  });

  it('writes the bytes under the run, at the path adapters are handed', () => {
    const saved = store.save(RUN, 'image/png', PNG.toString('base64'));

    // The adapters open this path themselves, so it must be the real file —
    // asserting through `read` alone would pass even if `pathOf` pointed
    // somewhere else entirely.
    const path = store.pathOf(RUN, saved.id);

    expect(path).toBe(join(root, RUN, saved.id));
    expect(readFileSync(path).equals(PNG)).toBe(true);
  });

  it('names the file by its media type so the type survives a restart', () => {
    // Nothing but the extension records the media type — the payload row is
    // re-read from disk on replay, long after the request that carried it.
    const saved = store.save(RUN, 'image/webp', PNG.toString('base64'));

    expect(saved.id.endsWith('.webp')).toBe(true);
    expect(store.read(RUN, saved.id).mediaType).toBe('image/webp');
  });

  it('refuses an id that walks out of the attachments root', () => {
    // The regression pin for the traversal guard. The target file EXISTS, so
    // without the guard the read succeeds and hands a file from outside the
    // attachments tree to any caller holding the token — a missing-file
    // assertion here would pass with the guard deleted.
    const secret = join(root, 'daemon-secret.png');
    writeFileSync(secret, 'launch-token');

    expect(() => store.read(RUN, `../${RUN}/../daemon-secret.png`)).toThrow(
      /no such attachment/,
    );
  });

  it('refuses a run id that walks out of the attachments root', () => {
    // The run half of the path is a route param too, so it needs the same
    // guard — a `..` there escapes just as well as one in the id. Again the
    // escaped file is real, so the guard is what makes this throw.
    const saved = store.save(RUN, 'image/png', PNG.toString('base64'));
    const escapedRun = join(root, '..', 'elsewhere');
    mkdirSync(escapedRun, { recursive: true });
    writeFileSync(join(escapedRun, saved.id), 'not yours');

    expect(() => store.read(`../elsewhere`, saved.id)).toThrow(
      /no such attachment/,
    );
  });

  it('refuses an image past the size cap', () => {
    const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64');

    expect(() => store.save(RUN, 'image/png', huge)).toThrow(/limit/);
  });

  it('refuses base64 that decodes to nothing', () => {
    expect(() => store.save(RUN, 'image/png', '!!!!')).toThrow(
      /no decodable image data/,
    );
  });

  it('reports a missing file as not found rather than throwing ENOENT', () => {
    expect(() =>
      store.read(RUN, '99999999-8888-7777-6666-555555555555.png'),
    ).toThrow(/no such attachment/);
  });
});
