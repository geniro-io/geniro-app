import { describe, expect, it } from 'vitest';

import { PAGE_BYTES } from '../../agents/services/thread-reader.service';
import { pagedText } from './paged-text';

const NEXT = /with offset (\d+)/;

function allPages(body: string): string[] {
  const pages: string[] = [];
  let offset = 0;
  for (;;) {
    const page = pagedText('Lead.', body, offset, 'Check.');
    pages.push(page);
    const next = NEXT.exec(page);
    if (!next) {
      return pages;
    }
    offset = Number(next[1]);
  }
}

const textOf = (page: string) => page.slice(page.indexOf('\n\n') + 2);

describe('pagedText', () => {
  it('answers a short body whole, with no position', () => {
    expect(pagedText('Lead.', 'short', 0, 'Check.')).toBe('Lead.\n\nshort');
  });

  it('pages a 256 KB body to its end, each page under the limit, lossless', () => {
    const body = 'строка текста\n'.repeat(11_000);
    const pages = allPages(body);
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.map(textOf).join('')).toBe(body);
    for (const page of pages) {
      expect(Buffer.byteLength(page)).toBeLessThanOrEqual(PAGE_BYTES);
    }
  });

  it('reaches the end of a body with no line break at all', () => {
    const body = 'я'.repeat(100_000);
    expect(allPages(body).map(textOf).join('')).toBe(body);
  });

  it('never cuts inside a surrogate pair', () => {
    const body = '😀'.repeat(30_000);
    const pages = allPages(body).map(textOf);
    expect(pages.join('')).toBe(body);
    for (const page of pages) {
      expect(Buffer.from(page, 'utf8').toString('utf8')).toBe(page);
    }
  });

  it('says so when the offset is past the end', () => {
    expect(pagedText('Lead.', 'short', 99, 'Check.')).toBe(
      'Lead. Nothing at offset 99: the answer is 5 characters.',
    );
  });
});
