import { describe, expect, it } from 'vitest';

import { isAllowedTopFrameNavigation } from './navigation-policy';

describe('isAllowedTopFrameNavigation', () => {
  it('allows the same development origin', () => {
    expect(
      isAllowedTopFrameNavigation(
        'http://localhost:5173/chats?run=1',
        'http://localhost:5173/',
      ),
    ).toBe(true);
  });

  it('rejects another development origin', () => {
    expect(
      isAllowedTopFrameNavigation(
        'https://example.com/',
        'http://localhost:5173/',
      ),
    ).toBe(false);
  });

  it('allows only the current packaged file document', () => {
    const current = 'file:///Applications/Geniro.app/renderer/index.html';
    expect(
      isAllowedTopFrameNavigation(`${current}?view=chats#latest`, current),
    ).toBe(true);
    expect(
      isAllowedTopFrameNavigation(
        'file:///Users/me/Downloads/untrusted.html',
        current,
      ),
    ).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedTopFrameNavigation('not a url', 'also bad')).toBe(false);
  });
});
