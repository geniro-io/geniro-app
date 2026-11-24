import { describe, expect, it } from 'vitest';

import { hostUiDownloads } from './host-ui';

function card(component: Record<string, unknown>): unknown {
  return {
    messages: [
      {
        version: '1.0',
        createSurface: { surfaceId: 's', components: [component] },
      },
    ],
  };
}

describe('hostUiDownloads', () => {
  it('asks for a picture, video or sound named by URL', () => {
    expect(
      hostUiDownloads(
        card({ id: 'root', component: 'Image', url: 'https://x.test/a.png' }),
      ),
    ).toBe(true);
    expect(
      hostUiDownloads(
        card({
          id: 'root',
          component: 'Video',
          url: '/tmp/a.mp4',
          posterUrl: 'http://x.test/p.png',
        }),
      ),
    ).toBe(true);
    expect(
      hostUiDownloads(
        card({
          id: 'root',
          component: 'AudioPlayer',
          url: 'https://x.test/a.mp3',
        }),
      ),
    ).toBe(true);
  });

  it('does not ask for local files or a link outside a media component', () => {
    expect(
      hostUiDownloads(
        card({ id: 'root', component: 'Image', url: '/tmp/a.png' }),
      ),
    ).toBe(false);
    expect(
      hostUiDownloads(
        card({
          id: 'root',
          component: 'Text',
          text: 'see https://x.test/a.png',
        }),
      ),
    ).toBe(false);
  });

  it('reads messages a CLI relayed as a JSON string', () => {
    expect(
      hostUiDownloads({
        messages: JSON.stringify([
          {
            version: '1.0',
            createSurface: {
              surfaceId: 's',
              components: [
                { id: 'root', component: 'Image', url: 'https://x.test/a.png' },
              ],
            },
          },
        ]),
      }),
    ).toBe(true);
  });

  it('asks when the CLI relayed no arguments', () => {
    expect(hostUiDownloads(null)).toBe(true);
    expect(hostUiDownloads({})).toBe(true);
  });
});
