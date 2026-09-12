import { describe, expect, it } from 'vitest';

import { MAX_REPORT_IMAGES, reportImagePaths } from './report-images';

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
