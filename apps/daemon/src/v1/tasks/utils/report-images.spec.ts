import { describe, expect, it } from 'vitest';

import {
  MAX_REPORT_IMAGES,
  reportImagePaths,
  rewriteReportImages,
} from './report-images';

describe('rewriteReportImages', () => {
  const copies = (entries: [string, string][]) => new Map(entries);

  it('points each image at its copy and leaves prose mentioning the path alone', () => {
    expect(
      rewriteReportImages(
        'See /tmp/a.png.\n![shot](/tmp/a.png "the panel")',
        copies([['/tmp/a.png', '/c/a.png']]),
      ),
    ).toBe('See /tmp/a.png.\n![shot](/c/a.png "the panel")');
  });

  it('rewrites the DESTINATION when the alt text repeats the path', () => {
    // A string replace inside the match found the path in the alt text first,
    // renamed the label and left the reference on the scratch file.
    expect(
      rewriteReportImages(
        '![/tmp/a.png](/tmp/a.png)',
        copies([['/tmp/a.png', '/c/a.png']]),
      ),
    ).toBe('![/tmp/a.png](/c/a.png)');
  });

  it('writes a copy’s name literally, never as a replacement pattern', () => {
    // `$&` is "the whole match" to `String.replace`, so the copy's own name
    // was expanded into the path it was replacing.
    expect(
      rewriteReportImages(
        '![a](/tmp/a.png)',
        copies([['/tmp/a.png', "/c/$&-$`-$'.png"]]),
      ),
    ).toBe("![a](/c/$&-$`-$'.png)");
  });

  it('angle-brackets a copy whose path a bare destination cannot hold', () => {
    // The app's own data directory is under `Application Support`, and a bare
    // markdown destination ends at the first space — the rewritten reference
    // rendered as text instead of the picture.
    const copy = '/Users/me/Library/Application Support/Geniro/a.png';
    const rewritten = rewriteReportImages(
      '![a](/tmp/a.png)',
      copies([['/tmp/a.png', copy]]),
    );

    expect(rewritten).toBe(`![a](<${copy}>)`);
    // And the rewritten report still reads back as that same image.
    expect(reportImagePaths(rewritten)).toEqual([copy]);
  });

  it('keeps an angle-bracketed reference angle-bracketed', () => {
    expect(
      rewriteReportImages(
        '![a](</tmp/my shot.png>)',
        copies([['/tmp/my shot.png', '/c/Application Support/a.png']]),
      ),
    ).toBe('![a](</c/Application Support/a.png>)');
  });
});

describe('reportImagePaths', () => {
  it('takes every markdown image with an absolute image path, in order, once', () => {
    const text = [
      'Done.',
      '![light](/tmp/shots/light.png)',
      '![dark](/tmp/shots/dark.PNG "the dark theme")',
      '![again](/tmp/shots/light.png)',
    ].join('\n');
    expect(reportImagePaths({ text })).toEqual([
      '/tmp/shots/light.png',
      '/tmp/shots/dark.PNG',
    ]);
  });

  it('reads a path with spaces in the angle-bracket form', () => {
    expect(
      reportImagePaths(
        '![shot](</Users/me/Library/Application Support/a.jpg>)',
      ),
    ).toEqual(['/Users/me/Library/Application Support/a.jpg']);
  });

  it('refuses what is not a picture of the work', () => {
    // A relative path names nothing the settle can open, a remote URL is not a
    // file on this machine, a link is not an image, and a bare path in prose
    // cannot be told from a sentence that merely mentions a file.
    expect(
      reportImagePaths(
        [
          '![rel](shots/a.png)',
          '![url](https://example.com/a.png)',
          '[link](/tmp/a.png)',
          'see /tmp/a.png',
          '![doc](/tmp/spec.pdf)',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('finds images anywhere in a findings payload, across several payloads', () => {
    expect(
      reportImagePaths([
        {
          findings: [
            { summary: 'panel', failure_scenario: '![before](/s/before.png)' },
          ],
        },
        { text: '![after](/s/after.webp)' },
      ]),
    ).toEqual(['/s/before.png', '/s/after.webp']);
  });

  it('stops at the cap, so one report cannot flood the card', () => {
    const text = Array.from(
      { length: MAX_REPORT_IMAGES + 5 },
      (_, i) => `![${i}](/s/${i}.png)`,
    ).join('\n');
    expect(reportImagePaths(text)).toHaveLength(MAX_REPORT_IMAGES);
  });
});
