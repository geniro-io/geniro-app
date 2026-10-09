import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { BadRequestException, NotFoundException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  localPathOf,
  MAX_ARTIFACT_IMAGE_BYTES,
  readArtifactImage,
} from './artifact-image-policy';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-test'),
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from('GIF89a-test', 'latin1');
const WEBP = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1');
const AVIF = Buffer.from(
  '\u0000\u0000\u0000\u001cftypavif\u0000\u0000\u0000\u0000',
  'latin1',
);

/** The message a read refuses with, so a test can see what the agent is told. */
function refusalMessageOf(read: () => unknown): string {
  try {
    read();
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
  }
  throw new Error('the read did not refuse');
}

/** The refusal code a read throws, or null when it does not refuse. */
function refusalOf(read: () => unknown): string | null {
  try {
    read();
    return null;
  } catch (error) {
    if (
      error instanceof BadRequestException ||
      error instanceof NotFoundException
    ) {
      return error.errorCode;
    }
    throw error;
  }
}

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'geniro-artifact-image-'));
  outside = mkdtempSync(join(tmpdir(), 'geniro-artifact-outside-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('readArtifactImage', () => {
  it('reads a PNG inside an allowed folder as image/png', () => {
    const file = join(root, 'after.png');
    writeFileSync(file, PNG);

    const image = readArtifactImage(file, [root]);

    expect(image.extension).toBe('png');
    expect(image.mediaType).toBe('image/png');
    expect(image.bytes.equals(PNG)).toBe(true);
  });

  it('identifies jpeg, gif, webp and avif by their bytes, whatever the file is called', () => {
    const cases: [Buffer, string, string][] = [
      [JPEG, 'shot.dat', 'jpg'],
      [GIF, 'shot.txt', 'gif'],
      [WEBP, 'shot.bin', 'webp'],
      [AVIF, 'shot.heic', 'avif'],
    ];

    const mediaTypes: Record<string, string> = {
      jpg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      avif: 'image/avif',
    };
    for (const [bytes, name, extension] of cases) {
      const file = join(root, name);
      writeFileSync(file, bytes);
      const image = readArtifactImage(file, [root]);
      expect(image.extension).toBe(extension);
      expect(image.mediaType).toBe(mediaTypes[extension]);
    }
  });

  it('refuses a file outside every allowed folder', () => {
    const file = join(outside, 'secret.png');
    writeFileSync(file, PNG);

    expect(refusalOf(() => readArtifactImage(file, [root]))).toBe(
      'IMAGE_OUTSIDE_ALLOWED_FOLDERS',
    );
  });

  it('refuses a symlink inside an allowed folder that points outside it', () => {
    const target = join(outside, 'secret.png');
    writeFileSync(target, PNG);
    const link = join(root, 'link.png');
    symlinkSync(target, link);

    expect(refusalOf(() => readArtifactImage(link, [root]))).toBe(
      'IMAGE_OUTSIDE_ALLOWED_FOLDERS',
    );
  });

  it('refuses a path that climbs out of an allowed folder with ..', () => {
    writeFileSync(join(outside, 'secret.png'), PNG);
    // Written as the agent wrote it: join() would normalise the `..` away first.
    const climbing = `${root}/../${basename(outside)}/secret.png`;

    expect(refusalOf(() => readArtifactImage(climbing, [root]))).toBe(
      'IMAGE_OUTSIDE_ALLOWED_FOLDERS',
    );
  });

  it('refuses a hard link to a file outside the allowed folders', () => {
    const target = join(outside, 'secret.png');
    writeFileSync(target, PNG);
    const link = join(root, 'linked.png');
    linkSync(target, link);

    expect(refusalOf(() => readArtifactImage(link, [root]))).toBe(
      'IMAGE_SHARED_FILE',
    );
  });

  it('refuses a file that is not an image, whatever its name', () => {
    const file = join(root, 'notes.png');
    writeFileSync(file, 'plain text, not a picture');

    expect(refusalOf(() => readArtifactImage(file, [root]))).toBe(
      'IMAGE_TYPE_UNSUPPORTED',
    );
  });

  it('refuses an svg, which is not on the list of formats', () => {
    const file = join(root, 'diagram.svg');
    writeFileSync(
      file,
      '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
    );

    expect(refusalOf(() => readArtifactImage(file, [root]))).toBe(
      'IMAGE_TYPE_UNSUPPORTED',
    );
  });

  it('refuses a named pipe as not a file, rather than waiting on it', () => {
    const pipe = join(root, 'pipe.png');
    execFileSync('mkfifo', [pipe]);

    expect(refusalOf(() => readArtifactImage(pipe, [root]))).toBe(
      'IMAGE_NOT_A_FILE',
    );
  });

  it('refuses a path outside the folders the same whether or not the file exists', () => {
    writeFileSync(join(outside, 'present.png'), PNG);

    const present = refusalMessageOf(() =>
      readArtifactImage(join(outside, 'present.png'), [root]),
    );
    const absent = refusalMessageOf(() =>
      readArtifactImage(join(outside, 'absent.png'), [root]),
    );

    expect(
      refusalOf(() => readArtifactImage(join(outside, 'absent.png'), [root])),
    ).toBe('IMAGE_OUTSIDE_ALLOWED_FOLDERS');
    expect(present).toContain('outside the folders');
    expect(absent).toContain('outside the folders');
  });

  it('does not name the allowed folders in the refusal, so the agent learns no more of the disk', () => {
    expect(
      refusalMessageOf(() =>
        readArtifactImage(join(outside, 'absent.png'), [root]),
      ),
    ).not.toContain(root);
  });

  it('refuses an image above the per-image limit', () => {
    const file = join(root, 'big.png');
    writeFileSync(
      file,
      Buffer.concat([PNG, Buffer.alloc(MAX_ARTIFACT_IMAGE_BYTES)]),
    );

    expect(refusalOf(() => readArtifactImage(file, [root]))).toBe(
      'IMAGE_TOO_LARGE',
    );
  });

  it('accepts an image exactly at the per-image limit', () => {
    const file = join(root, 'edge.png');
    writeFileSync(
      file,
      Buffer.concat([PNG, Buffer.alloc(MAX_ARTIFACT_IMAGE_BYTES - PNG.length)]),
    );

    expect(readArtifactImage(file, [root]).bytes.length).toBe(
      MAX_ARTIFACT_IMAGE_BYTES,
    );
  });

  it('refuses a relative path', () => {
    expect(refusalOf(() => readArtifactImage('shots/after.png', [root]))).toBe(
      'IMAGE_PATH_NOT_ABSOLUTE',
    );
  });

  it('refuses a path that names no file', () => {
    expect(
      refusalOf(() => readArtifactImage(join(root, 'missing.png'), [root])),
    ).toBe('IMAGE_NOT_FOUND');
  });

  it('refuses a directory that is named like an image', () => {
    const dir = join(root, 'folder.png');
    mkdirSync(dir);

    expect(refusalOf(() => readArtifactImage(dir, [root]))).toBe(
      'IMAGE_NOT_A_FILE',
    );
  });

  it('ignores an allowed root that does not exist', () => {
    const file = join(root, 'ok.png');
    writeFileSync(file, PNG);

    expect(readArtifactImage(file, [join(root, 'gone'), root]).extension).toBe(
      'png',
    );
  });

  it('matches a root given through a symlink against the real folder', () => {
    const file = join(root, 'ok.png');
    writeFileSync(file, PNG);
    const alias = join(outside, 'alias');
    symlinkSync(root, alias);

    expect(readArtifactImage(join(alias, 'ok.png'), [alias]).extension).toBe(
      'png',
    );
  });
});

describe('localPathOf', () => {
  it('reads a file: address as the path it names, and anything else as written', () => {
    expect(localPathOf('file:///tmp/shots/a.png')).toBe('/tmp/shots/a.png');
    expect(localPathOf('  /tmp/shots/a.png ')).toBe('/tmp/shots/a.png');
  });
});
