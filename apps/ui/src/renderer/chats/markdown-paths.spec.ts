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
