import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_IMAGE_FILE,
  isArtifactImageExtension,
  isLocalImageSource,
  mapImageSources,
} from './artifact-html-images';

describe('mapImageSources', () => {
  it('replaces the src of every image tag, whatever its quoting', () => {
    const html =
      '<img src="/tmp/a.png"> <img src=\'/tmp/b.png\'> <img alt=x src=/tmp/c.png>';
    const seen: string[] = [];

    const out = mapImageSources(html, (src) => {
      seen.push(src);
      return `images/${seen.length}.png`;
    });

    expect(seen).toEqual(['/tmp/a.png', '/tmp/b.png', '/tmp/c.png']);
    expect(out).toBe(
      '<img src="images/1.png"> <img src=\'images/2.png\'> <img alt=x src=images/3.png>',
    );
  });

  it('leaves data-src, srcset and every byte outside an image tag as written', () => {
    const html =
      '<p>see src="/tmp/no.png"</p><img data-src="/tmp/x.png" srcset="/tmp/y.png 2x" src="/tmp/z.png" width="40">';

    const out = mapImageSources(html, () => 'images/z.png');

    expect(out).toBe(
      '<p>see src="/tmp/no.png"</p><img data-src="/tmp/x.png" srcset="/tmp/y.png 2x" src="images/z.png" width="40">',
    );
  });

  it('finds the src past a quoted alt text that holds a `>`', () => {
    // A `>` inside quotes belongs to the attribute, so the tag runs on past it and
    // the picture after it is still rewritten.
    const seen: string[] = [];
    const out = mapImageSources('<img alt="a > b" src="/tmp/x.png">', (src) => {
      seen.push(src);
      return 'images/x.png';
    });

    expect(seen).toEqual(['/tmp/x.png']);
    expect(out).toBe('<img alt="a > b" src="images/x.png">');
  });

  it('does not take text inside a quoted alt for the src', () => {
    const seen: string[] = [];
    const out = mapImageSources(
      '<img alt="see src=/tmp/nope.png" src="/tmp/y.png">',
      (src) => {
        seen.push(src);
        return 'images/y.png';
      },
    );

    expect(seen).toEqual(['/tmp/y.png']);
    expect(out).toBe('<img alt="see src=/tmp/nope.png" src="images/y.png">');
  });

  it('maps only the first src, which is the one a browser shows', () => {
    const seen: string[] = [];
    const out = mapImageSources(
      '<img src="/tmp/a.png" src="/tmp/b.png">',
      (src) => {
        seen.push(src);
        return 'images/a.png';
      },
    );

    expect(seen).toEqual(['/tmp/a.png']);
    expect(out).toBe('<img src="images/a.png" src="/tmp/b.png">');
  });

  it('leaves a tag whose src has no value alone', () => {
    const html = '<img src alt="x">';
    expect(mapImageSources(html, () => 'images/x.png')).toBe(html);
  });

  it('writes a source back untouched, quoting and all, when the mapping keeps it', () => {
    const html = '<img src=/tmp/c.png>';
    expect(mapImageSources(html, (src) => src)).toBe(html);
  });
});

describe('isLocalImageSource', () => {
  it('admits absolute and relative paths, and refuses schemes, protocol-relative hosts and empty sources', () => {
    expect(isLocalImageSource('/tmp/a.png')).toBe(true);
    expect(isLocalImageSource('shots/a.png')).toBe(true);
    expect(isLocalImageSource('data:image/png;base64,AAAA')).toBe(false);
    expect(isLocalImageSource('https://example.com/a.png')).toBe(false);
    expect(isLocalImageSource('//cdn.example.com/a.png')).toBe(false);
    expect(isLocalImageSource('   ')).toBe(false);
  });

  it('takes a file: address as a local picture, and leaves a fragment or query alone', () => {
    expect(isLocalImageSource('file:///tmp/a.png')).toBe(true);
    expect(isLocalImageSource('#top')).toBe(false);
    expect(isLocalImageSource('?v=2')).toBe(false);
  });
});

describe('mapImageSources, as a browser reads a tag', () => {
  it('reads an unquoted source to whitespace or `>`, so a quote inside it is part of the path', () => {
    // A browser keeps the apostrophe: the value is /tmp/it's.png, and the text after
    // the tag is not part of it.
    const seen: string[] = [];
    const out = mapImageSources(
      "<img src=/tmp/it's.png><p>don't</p>",
      (src) => {
        seen.push(src);
        return 'images/x.png';
      },
    );

    expect(seen).toEqual(["/tmp/it's.png"]);
    expect(out).toBe("<img src=images/x.png><p>don't</p>");
  });

  it('matches the tag name and the attribute name without regard to case', () => {
    const out = mapImageSources('<IMG SRC="/tmp/a.png">', () => 'images/a.png');
    expect(out).toBe('<IMG SRC="images/a.png">');
  });

  it('leaves a tag whose name only begins with img alone', () => {
    const html = '<imgx src="/tmp/a.png"><img-x src="/tmp/b.png">';
    expect(mapImageSources(html, () => 'images/a.png')).toBe(html);
  });

  it('stops at the first tag that is never closed, as a browser drops the rest of the page', () => {
    // The first picture is rewritten; the second tag has no `>`, so the page is
    // written back from it on, as the agent wrote it.
    const html = '<img src="/tmp/a.png"><img src="/tmp/b.png';
    expect(mapImageSources(html, () => 'images/a.png')).toBe(
      '<img src="images/a.png"><img src="/tmp/b.png',
    );
  });

  it('reads a page of many unclosed tags in linear time, not in time that grows with its square', () => {
    // A page of 512KB of unclosed openers once cost about a minute of CPU on the
    // daemon's one thread. The bound is generous: a linear pass takes milliseconds.
    const html = '<img alt="x" '.repeat(45_000);
    const started = performance.now();
    const out = mapImageSources(html, () => 'images/a.png');
    const elapsed = performance.now() - started;

    expect(out).toBe(html);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('isArtifactImageExtension', () => {
  it('admits the five stored formats and nothing else', () => {
    for (const extension of ['png', 'jpg', 'webp', 'gif', 'avif']) {
      expect(isArtifactImageExtension(extension)).toBe(true);
    }
    for (const extension of ['svg', 'PNG', 'jpeg', '', 'png.exe']) {
      expect(isArtifactImageExtension(extension)).toBe(false);
    }
  });
});

describe('ARTIFACT_IMAGE_FILE', () => {
  it('names a stored picture by the hash of its bytes and one of the listed formats', () => {
    const hash = 'a'.repeat(64);
    expect(ARTIFACT_IMAGE_FILE.test(`${hash}.png`)).toBe(true);
    expect(ARTIFACT_IMAGE_FILE.test(`${hash}.avif`)).toBe(true);
  });

  it('refuses an svg, a name that is not a hash, and a path', () => {
    const hash = 'a'.repeat(64);
    expect(ARTIFACT_IMAGE_FILE.test(`${hash}.svg`)).toBe(false);
    expect(ARTIFACT_IMAGE_FILE.test('notes.png')).toBe(false);
    expect(ARTIFACT_IMAGE_FILE.test(`../${hash}.png`)).toBe(false);
  });
});
