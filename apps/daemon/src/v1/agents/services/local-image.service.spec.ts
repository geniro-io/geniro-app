import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_LOCAL_IMAGE_BYTES } from '../chat.types';
import type { RunDao } from '../dao/run.dao';
import { LocalImageService } from './local-image.service';

/** A one-pixel PNG — real bytes, so the media type is not the only evidence. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let root: string;
let cwd: string;

/** A RunDao stub answering one run's cwd. */
const daoFor = (runCwd: string | null, exists = true): RunDao =>
  ({
    getById: () => Promise.resolve(exists ? { cwd: runCwd } : null),
  }) as unknown as RunDao;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'geniro-img-'));
  cwd = join(root, 'project');
  mkdirSync(cwd, { recursive: true });
});

describe('LocalImageService', () => {
  it('reads an ABSOLUTE path outside the run cwd', async () => {
    // The form the author's own history actually contains — every markdown
    // image reference in `geniro.db` is either `/tmp/shots/…` (absolute, and
    // nowhere near a project folder) or a bare filename. A cwd-containment rule
    // would refuse the real case while calling itself security, and would be
    // protecting nothing: the agent wrote the reference and already reads the
    // disk with the user's own privileges.
    const outside = join(root, 'shots', 'x.png');
    mkdirSync(join(root, 'shots'));
    writeFileSync(outside, PNG);

    const result = await new LocalImageService(daoFor(cwd)).read('r1', outside);

    expect(result.mediaType).toBe('image/png');
    expect(Buffer.from(result.data, 'base64').equals(PNG)).toBe(true);
    // Echoed as WRITTEN, not as resolved — it is the renderer's cache key, and
    // the renderer only ever knows the reference the agent put in the markdown.
    expect(result.path).toBe(outside);
  });

  it('resolves a RELATIVE reference against the run’s own cwd', async () => {
    // `![](a.png)` — the other measured form. In the renderer a relative src
    // resolves against the app's origin, which has nothing to do with the
    // folder the agent was working in; this is the only base under which it
    // means anything.
    writeFileSync(join(cwd, 'a.png'), PNG);

    const result = await new LocalImageService(daoFor(cwd)).read('r1', 'a.png');

    expect(Buffer.from(result.data, 'base64').equals(PNG)).toBe(true);
    expect(result.path).toBe('a.png');
  });

  it('refuses a relative reference when the run has no cwd', async () => {
    // Falling back to the daemon's own working directory would read whatever
    // file happened to sit there under the name the agent used.
    await expect(
      new LocalImageService(daoFor(null)).read('r1', 'a.png'),
    ).rejects.toThrow(/no working directory/);
  });

  it('refuses a URL, so the route cannot become a fetch', async () => {
    // Local-first: the renderer declines these before asking, and this is the
    // second door. Reading it as a PATH would also be wrong — `resolve()` would
    // happily turn `https://evil/x.png` into a directory under the cwd.
    await expect(
      new LocalImageService(daoFor(cwd)).read(
        'r1',
        'https://example.com/x.png',
      ),
    ).rejects.toThrow(/not a path on this machine/);
  });

  it('refuses a path that is not an image, whatever it contains', async () => {
    // What keeps this an IMAGE channel rather than a file-read channel. The
    // extension is checked before anything is opened, so a reference naming a
    // key or a config is refused rather than read and discarded.
    writeFileSync(join(cwd, 'id_rsa'), 'PRIVATE KEY');

    await expect(
      new LocalImageService(daoFor(cwd)).read('r1', 'id_rsa'),
    ).rejects.toThrow(/not one of/);
  });

  it('refuses a directory that happens to be named like an image', async () => {
    // `.png` on a directory passes the extension gate; `readFileSync` on one
    // throws EISDIR, which without this check would surface as a 500 rather
    // than a refusal the renderer can render.
    mkdirSync(join(cwd, 'shots.png'));

    await expect(
      new LocalImageService(daoFor(cwd)).read('r1', 'shots.png'),
    ).rejects.toThrow(/not a file/);
  });

  it('refuses an image past the display ceiling', async () => {
    writeFileSync(
      join(cwd, 'huge.png'),
      Buffer.alloc(MAX_LOCAL_IMAGE_BYTES + 1),
    );

    await expect(
      new LocalImageService(daoFor(cwd)).read('r1', 'huge.png'),
    ).rejects.toThrow(/display limit/);
  });

  it('measures the SYMLINK’s target, not the link', async () => {
    // The size check and the read must decide about the same file. Checking the
    // link and reading the target is how a bounded read becomes an unbounded
    // one — `statSync` follows links, but only because the path was
    // canonicalized first, and this is what pins that ordering.
    const big = join(root, 'big.png');
    writeFileSync(big, Buffer.alloc(MAX_LOCAL_IMAGE_BYTES + 1));
    symlinkSync(big, join(cwd, 'link.png'));

    await expect(
      new LocalImageService(daoFor(cwd)).read('r1', 'link.png'),
    ).rejects.toThrow(/display limit/);
  });

  it('is a 404 for a missing file and for a missing run', async () => {
    await expect(
      new LocalImageService(daoFor(cwd)).read('r1', 'nope.png'),
    ).rejects.toThrow(/no file at/);
    await expect(
      new LocalImageService(daoFor(cwd, false)).read('gone', 'a.png'),
    ).rejects.toThrow(/no run gone/);
  });

  it('refuses an empty reference rather than resolving to the cwd itself', async () => {
    await expect(
      new LocalImageService(daoFor(cwd)).read('r1', '   '),
    ).rejects.toThrow(/no image path/);
  });
});
