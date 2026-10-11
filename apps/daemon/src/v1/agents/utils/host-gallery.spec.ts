import { describe, expect, it } from 'vitest';

import { HOST_GALLERY_TOOL } from '../chat.types';
import { isHostGalleryCall } from './host-gallery';

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
