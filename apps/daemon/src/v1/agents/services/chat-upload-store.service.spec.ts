import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { tempDir } from '../__tests__/temp-dir';
import { CHAT_UPLOAD_MAX_BYTES } from '../chat.types';
import { ChatUploadStoreService } from './chat-upload-store.service';

const ZIP = Buffer.from('PK\u0003\u0004 not really a zip');

describe('ChatUploadStoreService', () => {
  let root: string;
  let store: ChatUploadStoreService;

  beforeEach(() => {
    root = tempDir('chat-uploads-');
    store = new ChatUploadStoreService({ root });
  });

  it('writes the bytes under the root, keeping the file its own name', async () => {
    const stored = await store.store('bundle.zip', ZIP.toString('base64'));

    expect(stored.name).toBe('bundle.zip');
    expect(stored.bytes).toBe(ZIP.byteLength);
    expect(dirname(dirname(stored.path))).toBe(root);
    expect(stored.path.endsWith('/bundle.zip')).toBe(true);
    expect(readFileSync(stored.path).equals(ZIP)).toBe(true);
  });

  it('keeps two uploads of one name apart', async () => {
    const first = await store.store('notes.txt', ZIP.toString('base64'));
    const second = await store.store('notes.txt', ZIP.toString('base64'));

    expect(first.path).not.toBe(second.path);
  });

  it('cannot be named out of its directory', async () => {
    const stored = await store.store(
      '../../etc/passwd',
      ZIP.toString('base64'),
    );

    expect(stored.name).toBe('passwd');
    expect(dirname(dirname(stored.path))).toBe(root);
  });

  it('refuses an empty body, a dot name, and an oversize file', async () => {
    await expect(store.store('a.txt', '')).rejects.toThrow(/no decodable/);
    await expect(store.store('..', ZIP.toString('base64'))).rejects.toThrow(
      /not a usable file name/,
    );
    const big = Buffer.alloc(CHAT_UPLOAD_MAX_BYTES + 1).toString('base64');
    await expect(store.store('big.bin', big)).rejects.toThrow(/at most/);
  });

  it('removes exactly the uploads a run’s messages name', async () => {
    const named = await store.store('a.zip', ZIP.toString('base64'));
    const other = await store.store('b.zip', ZIP.toString('base64'));
    // A JSON payload, the shape teardown hands over.
    const payload = JSON.stringify({ text: `look at ${named.path} please` });

    const removed = await store.removeReferenced([payload]);

    expect(removed).toBe(1);
    expect(existsSync(dirname(named.path))).toBe(false);
    expect(existsSync(other.path)).toBe(true);
  });

  it('never removes anything outside a directory it minted', async () => {
    // A directory under the root whose name is not a uuid, and a path outside
    // the root that merely looks like one of its children.
    const foreign = join(root, 'keep-me');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'x'), 'x');

    const removed = await store.removeReferenced([
      `${foreign}/x`,
      `${root}-sibling/11111111-2222-3333-4444-555555555555/x`,
    ]);

    expect(removed).toBe(0);
    expect(existsSync(join(foreign, 'x'))).toBe(true);
  });
});
