import { describe, expect, it } from 'vitest';

import { localPathOf, wrapSpacedImagePaths } from './markdown-paths';

const SPACED = '/Users/me/Library/Application Support/Geniro/shot.png';

describe('wrapSpacedImagePaths', () => {
  it('puts a destination with a space in angle brackets, which is what makes it an image', () => {
    expect(wrapSpacedImagePaths(`see ![shot](${SPACED}) here`)).toBe(
      `see ![shot](<${SPACED}>) here`,
    );
  });

  it('leaves a destination without a space exactly as written', () => {
    const text = '![shot](/tmp/shot.png) and ![b](rel/b.png)';
    expect(wrapSpacedImagePaths(text)).toBe(text);
  });

  it('keeps a quoted title OUTSIDE the brackets', () => {
    expect(wrapSpacedImagePaths(`![shot](${SPACED} "Before")`)).toBe(
      `![shot](<${SPACED}> "Before")`,
    );
    // …and a title alone is not a space in the PATH.
    const titled = '![shot](/tmp/shot.png "the before shot")';
    expect(wrapSpacedImagePaths(titled)).toBe(titled);
  });

  it('leaves code that SHOWS such markdown untouched', () => {
    const fenced = `\`\`\`md\n![shot](${SPACED})\n\`\`\``;
    const inline = `write \`![shot](${SPACED})\` to embed it`;
    expect(wrapSpacedImagePaths(fenced)).toBe(fenced);
    expect(wrapSpacedImagePaths(inline)).toBe(inline);
  });

  it('leaves an already-bracketed destination alone', () => {
    const text = `![shot](<${SPACED}>)`;
    expect(wrapSpacedImagePaths(text)).toBe(text);
  });

  it('takes linear time over a destination that is mostly spaces', () => {
    // It runs on every image destination in every rendered message, on text an
    // agent wrote. The title was split off with `/^(.*?)(\s+(?:"…"|'…'))$/`,
    // which is QUADRATIC in a run of spaces with no title at its end: measured
    // at 1.3s for 50,000 and 4.7s for 100,000, with the renderer frozen for
    // all of it. The bound is two orders of magnitude over the linear scan.
    const text = `![x](a${' '.repeat(100_000)}b)`;

    const started = performance.now();
    const out = wrapSpacedImagePaths(text);
    const elapsed = performance.now() - started;

    expect(out).toBe(`![x](<a${' '.repeat(100_000)}b>)`);
    expect(elapsed).toBeLessThan(500);
  });

  it('splits a title off exactly where the old pattern did', () => {
    // The pattern the scan replaced, kept here as the ORACLE: the rewrite is
    // about time, and every destination it can finish on in time must come
    // out the same.
    const LEGACY_TITLED = /^(.*?)(\s+(?:"[^"\n]*"|'[^'\n]*'))$/;
    const legacy = (markdown: string): string =>
      markdown.replace(
        /!\[([^\]\n]*)\]\(([^)<\n][^)\n]*)\)/g,
        (whole, alt: string, destination: string) => {
          const trimmed = destination.trim();
          const titled = LEGACY_TITLED.exec(trimmed);
          const path = (titled?.[1] ?? trimmed).trim();
          return /\s/.test(path)
            ? `![${alt}](<${path}>${titled?.[2] ?? ''})`
            : whole;
        },
      );
    const destinations = [
      '/a b.png "t"',
      "/a b.png 't'",
      '/a b.png ""',
      '/a b.png "it\'s"',
      '/a b.png    "wide"',
      '/a b.png\t"tab"',
      `/a b.png ${String.fromCharCode(0xa0)}"nbsp"`,
      '/a "x" b "t"',
      '/a \'x\' b "t"',
      '/a b"t"',
      '/a b "',
      '"t"',
      '"',
      "'",
      '/a b.png "x\'',
      '/a b.png "t" ',
      ' /a b.png "t"',
      '/a b.png',
      '/plain.png "title"',
      '/plain.png',
      'x "a" "b"',
      '/a\rb "t"',
      `/a b ${String.fromCharCode(0x2028)}"t"`,
      `/a${String.fromCharCode(0x2029)}b.png "t"`,
    ];

    for (const destination of destinations) {
      const text = `![alt](${destination})`;
      expect(wrapSpacedImagePaths(text), destination).toBe(legacy(text));
    }
  });
});

describe('localPathOf', () => {
  it('decodes the %20 the markdown pipeline puts in a spaced path', () => {
    expect(
      localPathOf('/Users/me/Library/Application%20Support/Geniro/shot.png'),
    ).toBe(SPACED);
  });

  it('hands back text that is not valid percent-encoding, and inline data, as they came', () => {
    expect(localPathOf('/tmp/100%.png')).toBe('/tmp/100%.png');
    expect(localPathOf('data:image/png;base64,aGk%3D')).toBe(
      'data:image/png;base64,aGk%3D',
    );
  });
});
