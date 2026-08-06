import { describe, expect, it } from 'vitest';

import { isComposerSendKey } from './composer-keys';

describe('isComposerSendKey', () => {
  it('sends on a bare Enter', () => {
    expect(isComposerSendKey({ key: 'Enter', shiftKey: false })).toBe(true);
  });

  // The inversion itself: if Shift+Enter ever starts sending, the newline the
  // user types mid-message goes out as a message instead.
  it('does not send on Shift+Enter — that is the newline', () => {
    expect(isComposerSendKey({ key: 'Enter', shiftKey: true })).toBe(false);
  });

  it('still sends on the legacy Meta/Ctrl+Enter chord', () => {
    expect(
      isComposerSendKey({ key: 'Enter', shiftKey: false, keyCode: 13 }),
    ).toBe(true);
  });

  it('ignores every key that is not Enter', () => {
    for (const key of ['a', 'Escape', 'Tab', 'ArrowDown', ' ']) {
      expect(isComposerSendKey({ key, shiftKey: false })).toBe(false);
    }
  });

  // Without this branch an IME user confirming a candidate sends the message
  // mid-word — the defensive branch is only real if a test enters it.
  it('does not send while an IME composition is being confirmed', () => {
    expect(
      isComposerSendKey({
        key: 'Enter',
        shiftKey: false,
        nativeEvent: { isComposing: true },
      }),
    ).toBe(false);
  });

  it('does not send on the legacy keyCode 229 composition spelling', () => {
    expect(
      isComposerSendKey({ key: 'Enter', shiftKey: false, keyCode: 229 }),
    ).toBe(false);
  });

  it('sends when the event carries an explicitly finished composition', () => {
    expect(
      isComposerSendKey({
        key: 'Enter',
        shiftKey: false,
        nativeEvent: { isComposing: false },
      }),
    ).toBe(true);
  });
});
