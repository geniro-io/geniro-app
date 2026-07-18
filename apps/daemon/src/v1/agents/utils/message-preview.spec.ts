import { describe, expect, it } from 'vitest';

import { messageText } from './message-preview';

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
