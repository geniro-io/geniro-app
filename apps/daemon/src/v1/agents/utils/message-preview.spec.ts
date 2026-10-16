import { describe, expect, it } from 'vitest';

import {
  messagePreview,
  messageText,
  threadPreviewOf,
} from './message-preview';

const image = { id: 'shot.png', mediaType: 'image/png' };

describe('messagePreview', () => {
  // The exact strings are the renderer's too (`previewTextOf` in
  // chat-preview.ts, same rows): the two write one line in turns, so a wording
  // change on one side alone must fail here or in chat-preview.spec.ts.
  it.each([
    [
      'words, pictures or not',
      { text: 'see this', images: [image] },
      'see this',
    ],
    ['one picture alone', { text: '', images: [image] }, '🖼 Image'],
    [
      'two pictures, blank words',
      { text: '  ', images: [image, image] },
      '🖼 2 images',
    ],
    ['neither words nor pictures', { text: '' }, null],
    ['an empty picture list', { text: '', images: [] }, null],
  ])('previews %s', (_case, payload, expected) => {
    expect(messagePreview(JSON.stringify(payload))).toBe(expected);
  });

  it('previews nothing for a malformed payload instead of throwing', () => {
    expect(messagePreview('not json {')).toBeNull();
  });
});

describe('threadPreviewOf', () => {
  it('moves a background row’s preview to an image label when the message is image-only', () => {
    // REPORTED as "Thread doesnt have last message, but other have": an
    // image-only message (`text: ""`) is the newest thing said, and the live
    // push answered null for it, so a background row kept the words before it
    // while the list, on its next refetch, showed nothing at all.
    expect(
      threadPreviewOf({
        kind: 'message',
        payload: {
          text: '',
          images: [{ id: 'shot.png', mediaType: 'image/png' }],
        },
      }),
    ).toBe('🖼 Image');
  });
});

describe('messageText', () => {
  it('reads the text of a stored message payload', () => {
    expect(messageText(JSON.stringify({ text: 'hello there' }))).toBe(
      'hello there',
    );
  });

  it('returns null for a malformed (non-JSON) payload instead of throwing', () => {
    expect(messageText('not json {')).toBeNull();
  });

  it('returns null when the payload has no string text field', () => {
    expect(messageText(JSON.stringify({ text: 42 }))).toBeNull();
    expect(messageText(JSON.stringify('just a string'))).toBeNull();
    expect(messageText(JSON.stringify({ other: 'field' }))).toBeNull();
  });
});
