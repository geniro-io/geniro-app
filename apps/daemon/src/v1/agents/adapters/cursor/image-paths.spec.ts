import { describe, expect, it } from 'vitest';

import { withImagePaths } from './image-paths';

describe('withImagePaths', () => {
  it('leaves a text-only prompt untouched', () => {
    // cursor's stdin IS the prompt — a stray header on every turn would reach
    // the model as instruction text.
    expect(withImagePaths('fix the test')).toBe('fix the test');
    expect(withImagePaths('fix the test', [])).toBe('fix the test');
  });

  it('names each attached path above the prompt', () => {
    const prompt = withImagePaths('what is wrong here?', [
      { path: '/data/attachments/run/a.png', mediaType: 'image/png' },
      { path: '/data/attachments/run/b.png', mediaType: 'image/png' },
    ]);

    expect(prompt).toContain('/data/attachments/run/a.png');
    expect(prompt).toContain('/data/attachments/run/b.png');
    // The question must survive intact — it is the actual instruction.
    expect(prompt.endsWith('what is wrong here?')).toBe(true);
    // Paths come first: the question refers to them.
    expect(prompt.indexOf('/data/attachments/run/a.png')).toBeLessThan(
      prompt.indexOf('what is wrong here?'),
    );
  });

  it('matches its plurality to the attachment count', () => {
    const one = withImagePaths('x', [
      { path: '/a.png', mediaType: 'image/png' },
    ]);
    const two = withImagePaths('x', [
      { path: '/a.png', mediaType: 'image/png' },
      { path: '/b.png', mediaType: 'image/png' },
    ]);

    expect(one).toContain('this image file');
    expect(two).toContain('these image files');
  });
});
