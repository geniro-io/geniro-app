import { describe, expect, it } from 'vitest';

import { messageAttachments } from './attachment-payload';

describe('messageAttachments', () => {
  it('reads the rows the daemon wrote into a message payload', () => {
    expect(
      messageAttachments({
        text: 'what is wrong here?',
        images: [
          { id: 'abc.png', mediaType: 'image/png' },
          { id: 'def.webp', mediaType: 'image/webp' },
        ],
      }),
    ).toEqual([
      { id: 'abc.png', mediaType: 'image/png' },
      { id: 'def.webp', mediaType: 'image/webp' },
    ]);
  });

  it('is empty for every payload without images', () => {
    // `payload` is `z.unknown()` on the wire, so this runs over every item
    // kind in the transcript — a throw here would blank the whole thread.
    expect(messageAttachments({ text: 'hi' })).toEqual([]);
    expect(messageAttachments(null)).toEqual([]);
    expect(messageAttachments(undefined)).toEqual([]);
    expect(messageAttachments('a string payload')).toEqual([]);
    expect(messageAttachments({ images: 'not an array' })).toEqual([]);
  });

  it('drops a malformed row instead of rendering a broken image', () => {
    expect(
      messageAttachments({
        images: [
          { id: 'good.png', mediaType: 'image/png' },
          { id: 42, mediaType: 'image/png' },
          { mediaType: 'image/png' },
          { id: 'evil.exe', mediaType: 'application/x-executable' },
          null,
        ],
      }),
    ).toEqual([{ id: 'good.png', mediaType: 'image/png' }]);
  });
});
