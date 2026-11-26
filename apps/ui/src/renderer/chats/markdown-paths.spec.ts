import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  localPathOf,
  namesPicture,
  PICTURE_EXTENSIONS,
  wrapSpacedPaths,
} from './markdown-paths';

const SPACED = '/Users/me/Library/Application Support/Geniro/shot.png';

describe('wrapSpacedPaths', () => {
  it('puts a destination with a space in angle brackets, which is what makes it an image', () => {
    expect(wrapSpacedPaths(`see ![shot](${SPACED}) here`)).toBe(
      `see ![shot](<${SPACED}>) here`,
    );
  });

  it('leaves a destination without a space exactly as written', () => {
    const text = '![shot](/tmp/shot.png) and ![b](rel/b.png)';
    expect(wrapSpacedPaths(text)).toBe(text);
  });

  it('keeps a quoted title OUTSIDE the brackets', () => {
    expect(wrapSpacedPaths(`![shot](${SPACED} "Before")`)).toBe(
      `![shot](<${SPACED}> "Before")`,
    );
    // …and a title alone is not a space in the PATH.
    const titled = '![shot](/tmp/shot.png "the before shot")';
    expect(wrapSpacedPaths(titled)).toBe(titled);
  });

  it('leaves code that SHOWS such markdown untouched', () => {
    const fenced = `\`\`\`md\n![shot](${SPACED})\n\`\`\``;
    const inline = `write \`![shot](${SPACED})\` to embed it`;
    expect(wrapSpacedPaths(fenced)).toBe(fenced);
    expect(wrapSpacedPaths(inline)).toBe(inline);
  });

  it('leaves an already-bracketed destination alone', () => {
    const text = `![shot](<${SPACED}>)`;
    expect(wrapSpacedPaths(text)).toBe(text);
  });

  it('takes linear time over a destination that is mostly spaces', () => {
    // It runs on every image destination in every rendered message, on text an
    // agent wrote. The title was split off with `/^(.*?)(\s+(?:"…"|'…'))$/`,
    // which is QUADRATIC in a run of spaces with no title at its end: measured
    // at 1.3s for 50,000 and 4.7s for 100,000, with the renderer frozen for
    // all of it. The bound is two orders of magnitude over the linear scan.
    const text = `![x](a${' '.repeat(100_000)}b)`;

    const started = performance.now();
    const out = wrapSpacedPaths(text);
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
      expect(wrapSpacedPaths(text), destination).toBe(legacy(text));
    }
  });
});

describe('wrapSpacedPaths on a link', () => {
  const NOTES = '/Users/me/Library/Application Support/Geniro/notes.md';

  it('puts a local path with a space in angle brackets, which is what makes it a link', () => {
    expect(wrapSpacedPaths(`see [notes](${NOTES}) here`)).toBe(
      `see [notes](<${NOTES}>) here`,
    );
  });

  it('keeps a quoted title outside the brackets', () => {
    expect(wrapSpacedPaths(`[notes](${NOTES} "Notes")`)).toBe(
      `[notes](<${NOTES}> "Notes")`,
    );
  });

  it('leaves a link that names no local absolute path exactly as written', () => {
    for (const text of [
      '[site](https://example.com/a b)',
      '[rel](docs/a b.md)',
      '[host](//server/a b)',
      '[plain](/tmp/notes.md)',
      '[prose](/ the docs)',
      `[done](<${NOTES}>)`,
      `\\[not a link](${NOTES})`,
      `\\\\\\[not a link](${NOTES})`,
    ]) {
      expect(wrapSpacedPaths(text), text).toBe(text);
    }
  });

  it('wraps a path with non-ASCII names, balanced parentheses, or after an escaped backslash', () => {
    const russian = '/Users/me/Мои файлы/видео демо.mp4';
    const copied = '/Users/me/Foo (1)/a b.md';
    expect(wrapSpacedPaths(`[v](${russian})`)).toBe(`[v](<${russian}>)`);
    expect(wrapSpacedPaths(`[c](${copied})`)).toBe(`[c](<${copied}>)`);
    expect(wrapSpacedPaths(`C:\\\\[n](${NOTES})`)).toBe(
      `C:\\\\[n](<${NOTES}>)`,
    );
  });

  it('wraps an image and a link on one line, each by its own rule', () => {
    expect(
      wrapSpacedPaths(`![s](${SPACED}) [n](${NOTES}) [w](https://a b)`),
    ).toBe(`![s](<${SPACED}>) [n](<${NOTES}>) [w](https://a b)`);
  });

  it('takes linear time over a line of brackets that never close into a link', () => {
    for (const text of [
      `${'['.repeat(100_000)}](x`,
      '[x](a'.repeat(20_000),
      `${'!['.repeat(50_000)}](x`,
    ]) {
      const started = performance.now();
      wrapSpacedPaths(text);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it('leaves code that shows such a link untouched', () => {
    const fenced = `\`\`\`md\n[notes](${NOTES})\n\`\`\``;
    const inline = `write \`[notes](${NOTES})\` to link it`;
    expect(wrapSpacedPaths(fenced)).toBe(fenced);
    expect(wrapSpacedPaths(inline)).toBe(inline);
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

describe('namesPicture', () => {
  it('reads the extension of the file name, in any case', () => {
    expect(namesPicture('/tmp/shots/a.png')).toBe(true);
    expect(namesPicture('shots/a.JPEG')).toBe(true);
    expect(namesPicture('/tmp/plan-pages/page.html')).toBe(false);
  });

  it('knows exactly the extensions the daemon image route serves', () => {
    const daemon = readFileSync(
      join(
        __dirname,
        '../../../../daemon/src/v1/agents/services/local-image.service.ts',
      ),
      'utf8',
    );
    const map =
      /const IMAGE_EXTENSIONS[^{]*\{([^}]*)\}/.exec(daemon)?.[1] ?? '';
    const served = [...map.matchAll(/'(\.[a-z]+)':/g)].map((m) => m[1]);
    expect(served.length).toBeGreaterThan(0);
    expect([...PICTURE_EXTENSIONS].sort()).toEqual(served.sort());
  });

  it('takes a dot in a folder name or a leading dot for no extension', () => {
    expect(namesPicture('/tmp/shots.png/notes')).toBe(false);
    expect(namesPicture('/tmp/.png')).toBe(false);
  });
});
