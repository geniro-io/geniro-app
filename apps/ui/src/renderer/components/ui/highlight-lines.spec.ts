import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { highlightLines } from './highlight-lines';

function markupOf(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

describe('highlightLines', () => {
  it('returns one node per input line, blank lines included', () => {
    const lines = ['const a = 1;', '', 'const b = 2;'];
    expect(highlightLines(lines, 'typescript')).toHaveLength(lines.length);
  });

  it('gives a TypeScript line its token classes', () => {
    const [first] = highlightLines(['const a = 1;'], 'typescript');
    expect(markupOf(first)).toContain('token keyword');
  });

  it('keeps a block comment class on every line the comment spans', () => {
    const nodes = highlightLines(
      ['/* first', ' second */', 'const x = 1;'],
      'typescript',
    );
    expect(markupOf(nodes[0])).toContain('token comment');
    expect(markupOf(nodes[1])).toContain('token comment');
    expect(markupOf(nodes[2])).not.toContain('token comment');
  });

  it('keeps the text of each line as it was', () => {
    const lines = ['const a = 1;', '  return a;', ''];
    const nodes = highlightLines(lines, 'typescript');
    nodes.forEach((node, index) => {
      expect(markupOf(node).replace(/<[^>]+>/g, '')).toBe(lines[index]);
    });
  });

  it('renders the lines as plain text for a language with no grammar', () => {
    expect(highlightLines(['a', 'b'], 'no-such-language')).toEqual(['a', 'b']);
  });

  it('renders the lines as plain text when there is no language', () => {
    expect(highlightLines(['a', 'b'], null)).toEqual(['a', 'b']);
  });

  it('draws each run of text through renderText, inside its token spans and without a grammar', () => {
    const mark = (text: string): ReactNode =>
      createElement('mark', null, text.toUpperCase());
    const [lit] = highlightLines(['const a = 1;'], 'typescript', mark);
    expect(markupOf(lit)).toContain(
      '<span class="token keyword"><mark>CONST</mark></span>',
    );
    expect(markupOf(highlightLines(['b'], null, mark)[0])).toBe(
      '<mark>B</mark>',
    );
  });

  it('returns no nodes for no lines', () => {
    expect(highlightLines([], 'typescript')).toEqual([]);
  });
});
