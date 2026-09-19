import { describe, expect, it } from 'vitest';

import { collapseImageBlocks } from './export-image-blocks';

/** A base64 payload past the collapse floor, of a known decoded size. */
const base64 = (bytes: number): string =>
  'A'.repeat(Math.ceil((bytes * 4) / 3));

describe('collapseImageBlocks', () => {
  it('collapses claude’s own content block, naming its type and size', () => {
    // The shape verbatim out of a real export — `source.media_type`, snake case.
    // This is the block that made 13.8 MB of a 28.9 MB file.
    expect(
      collapseImageBlocks([
        {
          type: 'image',
          source: {
            type: 'base64',
            data: base64(171 * 1024),
            media_type: 'image/png',
          },
        },
      ]),
    ).toEqual(['[image: image/png, 171 KB]']);
  });

  it('collapses the ACP block, whose keys are the other spelling', () => {
    // `{type, mimeType, data}` — how the cursor transport carries one.
    expect(
      collapseImageBlocks({
        type: 'image',
        mimeType: 'image/jpeg',
        data: base64(40 * 1024),
      }),
    ).toBe('[image: image/jpeg, 40 KB]');
  });

  it('reaches a block nested anywhere in the payload', () => {
    // It walks rather than knowing where a CLI puts its images, so a third shape
    // of wrapper is the caller's problem and not this module's.
    expect(
      collapseImageBlocks({
        result: {
          content: [
            { type: 'text', text: 'here it is' },
            {
              type: 'image',
              source: { data: base64(2 * 1024), media_type: 'image/png' },
            },
          ],
        },
      }),
    ).toEqual({
      result: {
        content: [
          { type: 'text', text: 'here it is' },
          '[image: image/png, 2 KB]',
        ],
      },
    });
  });

  it('returns the value UNCHANGED, by identity, when it holds no image', () => {
    // Every payload in an ordinary chat takes this path, so it must allocate
    // nothing and the export must be byte-identical to what it was.
    const payload = { result: { stdout: 'ok', nested: [1, 2, { a: 'b' }] } };
    expect(collapseImageBlocks(payload)).toBe(payload);
  });

  it('leaves a long base64 string alone unless something DECLARED it an image', () => {
    // A blob nobody said was a picture could be anything, and a reader who loses
    // it has lost the only copy in the file.
    const payload = { data: base64(100 * 1024) };
    expect(collapseImageBlocks(payload)).toBe(payload);
  });

  it('leaves a tiny inline image as itself', () => {
    // The point is the megabytes. A 40-byte icon is more useful than a line
    // claiming it was 0 KB.
    const payload = { type: 'image', mimeType: 'image/gif', data: 'R0lGODlh' };
    expect(collapseImageBlocks(payload)).toBe(payload);
  });

  it('names the type as `image` when the block did not', () => {
    expect(collapseImageBlocks({ type: 'image', data: base64(5 * 1024) })).toBe(
      '[image: image, 5 KB]',
    );
  });
});
