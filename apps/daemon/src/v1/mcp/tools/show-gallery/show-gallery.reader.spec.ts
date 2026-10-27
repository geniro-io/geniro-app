import { describe, expect, it } from 'vitest';

import {
  MAX_GALLERY_CAPTION_LENGTH,
  MAX_GALLERY_DESCRIPTION_LENGTH,
  MAX_GALLERY_IMAGES,
  MAX_GALLERY_PATH_LENGTH,
} from '../../../agents/chat.types';
import { hostGalleryResultText, readHostGallery } from './show-gallery.reader';

describe('readHostGallery', () => {
  it('reads the documented object form, captions and all', () => {
    expect(
      readHostGallery({
        title: 'Before and after',
        images: [
          { path: '/tmp/shots/before.png', caption: 'the old header' },
          { path: 'after.png' },
        ],
      }),
    ).toEqual({
      title: 'Before and after',
      images: [
        { path: '/tmp/shots/before.png', caption: 'the old header' },
        { path: 'after.png' },
      ],
    });
  });

  it('accepts a bare list of paths', () => {
    // The shape a model reaches for when it has nothing to caption. Refusing it
    // would answer the commonest call with "malformed".
    expect(readHostGallery({ images: ['a.png', 'b.png'] })).toEqual({
      images: [{ path: 'a.png' }, { path: 'b.png' }],
    });
  });

  it('accepts `src` as a synonym for `path`', () => {
    expect(readHostGallery({ images: [{ src: 'a.png' }] })).toEqual({
      images: [{ path: 'a.png' }],
    });
  });

  it('accepts `url` as a synonym for `path`, and keeps a URL as written', () => {
    expect(
      readHostGallery({ images: [{ url: 'https://example.com/a.png' }] }),
    ).toEqual({ images: [{ path: 'https://example.com/a.png' }] });
  });

  it('reads a description with its line breaks, and never a source', () => {
    expect(
      readHostGallery({
        images: [
          {
            path: 'a.png',
            caption: 'Khinkali',
            description: '  5 pcs\n2 400 ₸  ',
            source: 'https://evil.example/claimed.png',
          },
        ],
      }),
    ).toEqual({
      images: [
        { path: 'a.png', caption: 'Khinkali', description: '5 pcs\n2 400 ₸' },
      ],
    });
  });

  it('drops an entry that names no file, keeping the ones that do', () => {
    // DROPPED rather than blanked, unlike a chart's positional cells: a gallery
    // is a SET, so a tile naming no file is a tile with nothing to draw.
    expect(
      readHostGallery({
        images: [{ path: 'a.png' }, { caption: 'no file' }, 42, null, 'b.png'],
      }),
    ).toEqual({ images: [{ path: 'a.png' }, { path: 'b.png' }] });
  });

  it('answers null when nothing in the call names a picture', () => {
    // A malformed call, not an empty result — a gallery of no pictures is only
    // ever a mistake, so the MCP branch answers INVALID_ARGS.
    expect(readHostGallery({ images: [] })).toBeNull();
    expect(
      readHostGallery({ images: [{ caption: 'only a caption' }] }),
    ).toBeNull();
    expect(readHostGallery({})).toBeNull();
    expect(readHostGallery({ images: 'a.png' })).toBeNull();
  });

  it('truncates the image list rather than refusing the call', () => {
    const many = Array.from(
      { length: MAX_GALLERY_IMAGES + 6 },
      (_, i) => `shot-${i}.png`,
    );

    const gallery = readHostGallery({ images: many });

    expect(gallery?.images).toHaveLength(MAX_GALLERY_IMAGES);
    // The FIRST ones survive: an agent lists what it most wants looked at first.
    expect(gallery?.images[0]).toEqual({ path: 'shot-0.png' });
  });

  it('counts the cap against what SURVIVES, not what was sent', () => {
    // Slicing before filtering would answer "no image to show" for a call whose
    // opening entries are junk while it names perfectly good files below them —
    // the agent is then told its gallery was empty when it was not.
    const junk = Array.from({ length: MAX_GALLERY_IMAGES }, () => ({
      caption: 'no path here',
    }));

    expect(readHostGallery({ images: [...junk, 'real.png'] })).toEqual({
      images: [{ path: 'real.png' }],
    });
  });

  it('truncates an over-long path and caption to their caps', () => {
    const gallery = readHostGallery({
      images: [
        {
          path: `/${'d'.repeat(MAX_GALLERY_PATH_LENGTH + 50)}.png`,
          caption: 'c'.repeat(MAX_GALLERY_CAPTION_LENGTH + 50),
          description: 'd'.repeat(MAX_GALLERY_DESCRIPTION_LENGTH + 50),
        },
      ],
    });

    expect(gallery?.images[0]?.path).toHaveLength(MAX_GALLERY_PATH_LENGTH);
    expect(gallery?.images[0]?.caption).toHaveLength(
      MAX_GALLERY_CAPTION_LENGTH,
    );
    expect(gallery?.images[0]?.description).toHaveLength(
      MAX_GALLERY_DESCRIPTION_LENGTH,
    );
  });

  it('leaves a blank title absent rather than storing an empty heading', () => {
    expect(readHostGallery({ title: '   ', images: ['a.png'] })).toEqual({
      images: [{ path: 'a.png' }],
    });
  });
});

describe('hostGalleryResultText', () => {
  it('is a RECEIPT — it counts the images and never names them', () => {
    // The whole bargain of a host-drawn card: the payload goes to the screen
    // instead of back through the model's window. A result echoing the paths
    // would put every one of them in that window twice.
    const text = hostGalleryResultText({ status: 'drawn', images: 3 });

    expect(text).toBe('Gallery shown to the user: 3 images.');
    expect(text).not.toContain('.png');
  });

  it('counts one image in the singular', () => {
    expect(hostGalleryResultText({ status: 'drawn', images: 1 })).toBe(
      'Gallery shown to the user: 1 image.',
    );
  });

  it('tells the agent what to do instead when it could not be shown', () => {
    expect(
      hostGalleryResultText({ status: 'unavailable', reason: 'no turn' }),
    ).toContain('Describe the images in your reply instead.');
  });

  it('names each URL that could not be downloaded, and why', () => {
    expect(
      hostGalleryResultText({ status: 'drawn', images: 2 }, [
        {
          url: 'https://a.example/x.png',
          reason: 'the server answered HTTP 404',
        },
      ]),
    ).toBe(
      'Gallery shown to the user: 2 images. 1 image could not be downloaded: ' +
        'https://a.example/x.png (the server answered HTTP 404).',
    );
  });

  it('says why nothing was shown when no URL could be downloaded', () => {
    expect(
      hostGalleryResultText(
        { status: 'unavailable', reason: 'no image could be downloaded' },
        [
          { url: 'https://a.example/x.png', reason: 'the download timed out' },
          { url: 'https://b.example/y.png', reason: 'too many redirects' },
        ],
      ),
    ).toBe(
      'The gallery could not be shown (no image could be downloaded). 2 images could not be ' +
        'downloaded: https://a.example/x.png (the download timed out); https://b.example/y.png ' +
        '(too many redirects). Describe the images in your reply instead.',
    );
  });
});
