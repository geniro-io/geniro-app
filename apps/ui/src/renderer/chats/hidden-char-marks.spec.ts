import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { markHiddenChars } from './hidden-char-marks';

function markupOf(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

function shown(node: ReactNode): string {
  return markupOf(node)
    .replace(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"');
}

describe('markHiddenChars', () => {
  it('shows a zero-width space and a right-to-left override as marks, and never the characters', () => {
    const line = 'const c = "a\u200Bb\u202Ec";';
    const text = shown(markHiddenChars(line));

    expect(text).toBe('const c = "a<U+200B>b<U+202E>c";');
    expect(markupOf(markHiddenChars(line))).not.toMatch(/[\u200B\u202E]/);
    expect(markupOf(markHiddenChars(line))).toContain(
      'title="Bidirectional override — U+202E"',
    );
  });

  it('leaves tabs, line breaks and an emoji built with a joiner as they are', () => {
    const text = '\tif (a) {\n  say("👩\u200D💻");\r\n}';
    expect(markHiddenChars(text)).toBe(text);
  });

  it('marks a character outside the basic plane once, keeping the text after it', () => {
    expect(shown(markHiddenChars('x\u{E0041}y'))).toBe('x<U+E0041>y');
  });
});
