import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildImageBlocks } from './claude-images.utils';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const writeImage = (name: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'claude-images-')), name);
  writeFileSync(path, PNG);
  return path;
};

describe('buildImageBlocks', () => {
  it('reads each image into a base64 content block', () => {
    const path = writeImage('shot.png');

    const blocks = buildImageBlocks([{ path, mediaType: 'image/png' }]);

    expect(blocks).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          // The bytes actually on disk, not a string the test built.
          data: PNG.toString('base64'),
        },
      },
    ]);
  });

  it('keeps the images in order', () => {
    const first = writeImage('a.png');
    const second = writeImage('b.png');

    const blocks = buildImageBlocks([
      { path: first, mediaType: 'image/png' },
      { path: second, mediaType: 'image/webp' },
    ]);

    expect(blocks.map((block) => block.source.media_type)).toEqual([
      'image/png',
      'image/webp',
    ]);
  });

  it('is empty for a turn with no images', () => {
    expect(buildImageBlocks()).toEqual([]);
    expect(buildImageBlocks([])).toEqual([]);
  });

  it('throws rather than silently dropping an unreadable image', () => {
    // The pin for the deliberate non-defensive choice: skipping the file would
    // leave the agent answering confidently about a screenshot it never got.
    expect(() =>
      buildImageBlocks([{ path: '/nope/missing.png', mediaType: 'image/png' }]),
    ).toThrow();
  });
});
