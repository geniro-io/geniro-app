import { describe, expect, it } from 'vitest';

import { HOST_GALLERY_TOOL } from '../chat.types';
import { hostGalleryDownloads, isHostGalleryCall } from './host-gallery';

const SERVER = 'geniro-1a2b3c4d';

describe('isHostGalleryCall', () => {
  it("matches claude's spelling, which wraps the per-run server name", () => {
    expect(
      isHostGalleryCall(SERVER, `mcp__${SERVER}__${HOST_GALLERY_TOOL}`),
    ).toBe(true);
  });

  it('matches cursor’s measured title, `<server>-<tool>: <tool>`', () => {
    expect(
      isHostGalleryCall(
        SERVER,
        `${SERVER}-${HOST_GALLERY_TOOL}: ${HOST_GALLERY_TOOL}`,
      ),
    ).toBe(true);
  });

  it('refuses a same-named tool on somebody else’s server', () => {
    // A user's own MCP server may legitimately expose a `show_gallery`, and it
    // must not inherit this app's auto-approval — which is the whole reason the
    // server name is part of the match.
    expect(isHostGalleryCall(SERVER, `acme-shots: ${HOST_GALLERY_TOOL}`)).toBe(
      false,
    );
    expect(isHostGalleryCall(SERVER, 'mcp__acme__show_gallery')).toBe(false);
  });
});

describe('hostGalleryDownloads', () => {
  it('finds a URL in any of the forms a call can name a picture in', () => {
    expect(hostGalleryDownloads({ images: ['https://a.example/x.png'] })).toBe(
      true,
    );
    expect(
      hostGalleryDownloads({ images: [{ url: 'http://a.example/x.png' }] }),
    ).toBe(true);
    expect(
      hostGalleryDownloads({ images: [{ src: ' HTTPS://a.example/x.png' }] }),
    ).toBe(true);
  });

  it('finds a URL however the CLI wraps the arguments', () => {
    expect(
      hostGalleryDownloads({
        arguments: { images: [{ path: 'https://a.example/x.png' }] },
      }),
    ).toBe(true);
  });

  it('reads a gallery of local files as no download', () => {
    expect(
      hostGalleryDownloads({
        title: 'Shots',
        images: [
          '/tmp/a.png',
          { path: 'b.png', description: 'see https://a.example for more' },
        ],
      }),
    ).toBe(false);
  });

  it('counts arguments the CLI did not relay as a download, so the user is asked', () => {
    expect(hostGalleryDownloads(undefined)).toBe(true);
    expect(hostGalleryDownloads(null)).toBe(true);
    expect(hostGalleryDownloads({})).toBe(true);
  });
});
