import { describe, expect, it } from 'vitest';

import { isWithinDirectory } from './path-within';

describe('isWithinDirectory', () => {
  it('matches the directory itself and anything under it', () => {
    expect(isWithinDirectory('/work/app', '/work/app')).toBe(true);
    expect(isWithinDirectory('/work/app/apps/ui', '/work/app')).toBe(true);
  });

  it('does not match a SIBLING whose name merely starts the same', () => {
    // The whole reason this is not `startsWith`: a group pointed at
    // `/work/app` would otherwise claim every chat opened in `/work/app-old`,
    // and the two are unrelated projects.
    expect(isWithinDirectory('/work/app-old', '/work/app')).toBe(false);
    expect(isWithinDirectory('/work/application', '/work/app')).toBe(false);
  });

  it('does not match a parent or an unrelated tree', () => {
    expect(isWithinDirectory('/work', '/work/app')).toBe(false);
    expect(isWithinDirectory('/elsewhere/app', '/work/app')).toBe(false);
  });

  it('handles the filesystem root, which already ends in a separator', () => {
    // Appending a second separator would ask about `//work` and match nothing,
    // so a group pointed at `/` would silently claim no chat at all.
    expect(isWithinDirectory('/work/app', '/')).toBe(true);
    expect(isWithinDirectory('/', '/')).toBe(true);
  });
});
