import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tempDir } from '../../__tests__/temp-dir';
import { buildAcpImageBlocks } from './acp-content';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const writeImage = (name: string): string => {
  const path = join(tempDir('acp-images-'), name);
  writeFileSync(path, PNG);
  return path;
};

describe('buildAcpImageBlocks', () => {
  it('reads each image into an ACP image block', () => {
    const path = writeImage('shot.png');

    expect(buildAcpImageBlocks([{ path, mediaType: 'image/png' }])).toEqual([
      // ACP names these `mimeType`/`data` — NOT claude's nested
      // `source.media_type`. The two shapes are why this is protocol code
      // rather than a helper shared with the other adapter.
      { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') },
    ]);
  });

  it('keeps the images in order', () => {
    const first = writeImage('a.png');
    const second = writeImage('b.png');

    const blocks = buildAcpImageBlocks([
      { path: first, mediaType: 'image/png' },
      { path: second, mediaType: 'image/webp' },
    ]);

    expect(blocks.map((block) => block.mimeType)).toEqual([
      'image/png',
      'image/webp',
    ]);
  });

  it('is empty for a turn with no images', () => {
    expect(buildAcpImageBlocks()).toEqual([]);
    expect(buildAcpImageBlocks([])).toEqual([]);
  });

  it('throws rather than silently dropping an unreadable image', () => {
    // Same deliberate non-defensive choice as the claude path: skipping the
    // file would leave the agent answering confidently about a screenshot it
    // never received.
    expect(() =>
      buildAcpImageBlocks([
        { path: '/nope/missing.png', mediaType: 'image/png' },
      ]),
    ).toThrow();
  });
});
