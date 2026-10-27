import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RemoteImageError } from '../utils/remote-image';
import { AttachmentStoreService } from './attachment-store.service';
import { GalleryImageService } from './gallery-image.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

let root: string;
let attachments: AttachmentStoreService;
const runId = randomUUID();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gallery-images-'));
  attachments = new AttachmentStoreService({ root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('GalleryImageService.localize', () => {
  it('replaces each URL with its downloaded file and keeps the URL as the source', async () => {
    const asked: string[] = [];
    const service = new GalleryImageService(attachments, {
      download: (url) => {
        asked.push(url);
        return Promise.resolve({ mediaType: 'image/png', bytes: PNG });
      },
    });

    const { gallery, failures } = await service.localize(runId, {
      title: 'Menu',
      images: [
        { path: '/tmp/local.png', caption: 'on disk' },
        {
          path: 'https://cdn.example/khinkali.png',
          caption: 'Khinkali',
          description: '5 pcs',
        },
      ],
    });

    expect(asked).toEqual(['https://cdn.example/khinkali.png']);
    expect(failures).toEqual([]);
    expect(gallery?.title).toBe('Menu');
    expect(gallery?.images[0]).toEqual({
      path: '/tmp/local.png',
      caption: 'on disk',
    });
    const stored = gallery?.images[1];
    expect(stored?.source).toBe('https://cdn.example/khinkali.png');
    expect(stored?.caption).toBe('Khinkali');
    expect(stored?.description).toBe('5 pcs');
    expect(stored?.path.startsWith(join(root, runId))).toBe(true);
    expect(stored?.path.endsWith('.png')).toBe(true);
    expect(readFileSync(stored!.path).equals(PNG)).toBe(true);
  });

  it('drops a URL that cannot be downloaded and reports why, keeping the order of the rest', async () => {
    const service = new GalleryImageService(attachments, {
      download: (url) =>
        url.includes('broken')
          ? Promise.reject(new RemoteImageError('the server answered HTTP 404'))
          : Promise.resolve({ mediaType: 'image/png', bytes: PNG }),
    });

    const { gallery, failures } = await service.localize(runId, {
      images: [
        { path: 'https://cdn.example/1.png' },
        { path: 'https://cdn.example/broken.png' },
        { path: '/tmp/3.png' },
      ],
    });

    expect(failures).toEqual([
      {
        url: 'https://cdn.example/broken.png',
        reason: 'the server answered HTTP 404',
      },
    ]);
    expect(gallery?.images.map((image) => image.source ?? image.path)).toEqual([
      'https://cdn.example/1.png',
      '/tmp/3.png',
    ]);
  });

  it('answers null when no picture is left to show', async () => {
    const service = new GalleryImageService(attachments, {
      download: () =>
        Promise.reject(new RemoteImageError('too many redirects')),
    });

    const { gallery, failures } = await service.localize(runId, {
      images: [{ path: 'https://cdn.example/a.png' }],
    });

    expect(gallery).toBeNull();
    expect(failures).toEqual([
      { url: 'https://cdn.example/a.png', reason: 'too many redirects' },
    ]);
  });

  it('keeps a storage failure out of the reason it gives the agent', async () => {
    const service = new GalleryImageService(attachments, {
      download: () => Promise.resolve({ mediaType: 'image/png', bytes: PNG }),
    });

    const { failures } = await service.localize('not-a-run-id', {
      images: [{ path: 'https://cdn.example/a.png' }],
    });

    expect(failures).toEqual([
      {
        url: 'https://cdn.example/a.png',
        reason: 'the downloaded image could not be stored',
      },
    ]);
  });

  it('stores the downloads under the run, so the run teardown removes them', async () => {
    const service = new GalleryImageService(attachments, {
      download: () => Promise.resolve({ mediaType: 'image/png', bytes: PNG }),
    });
    const { gallery } = await service.localize(runId, {
      images: [{ path: 'https://cdn.example/a.png' }],
    });
    const path = gallery!.images[0]!.path;

    attachments.removeRun(runId);

    expect(() => readFileSync(path)).toThrow();
  });

  it('stops every download still out when the call runs out of time', async () => {
    const service = new GalleryImageService(attachments, {
      budgetMs: 50,
      download: (url, options) =>
        url.includes('fast')
          ? Promise.resolve({ mediaType: 'image/png', bytes: PNG })
          : new Promise((_resolve, reject) => {
              options!.signal!.addEventListener('abort', () =>
                reject(new RemoteImageError(options!.abortReason!)),
              );
            }),
    });

    const { gallery, failures } = await service.localize(runId, {
      images: [
        { path: 'https://cdn.example/fast.png' },
        { path: 'https://cdn.example/stuck.png' },
      ],
    });

    expect(gallery?.images.map((image) => image.source)).toEqual([
      'https://cdn.example/fast.png',
    ]);
    expect(failures).toEqual([
      {
        url: 'https://cdn.example/stuck.png',
        reason: "the gallery's download time ran out",
      },
    ]);
  });

  it('downloads nothing once the caller has stopped the call', async () => {
    const asked: string[] = [];
    const service = new GalleryImageService(attachments, {
      download: (url) => {
        asked.push(url);
        return Promise.resolve({ mediaType: 'image/png', bytes: PNG });
      },
    });
    const stop = new AbortController();
    stop.abort();

    const { gallery } = await service.localize(
      runId,
      { images: [{ path: 'https://cdn.example/a.png' }] },
      stop.signal,
    );

    expect(asked).toEqual([]);
    expect(gallery).toBeNull();
  });

  it('refuses further downloads once the run has spent its budget', async () => {
    const service = new GalleryImageService(attachments, {
      maxRunBytes: PNG.length,
      download: () => Promise.resolve({ mediaType: 'image/png', bytes: PNG }),
    });

    await service.localize(runId, {
      images: [{ path: 'https://cdn.example/a.png' }],
    });
    const { failures } = await service.localize(runId, {
      images: [{ path: 'https://cdn.example/b.png' }],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatch(
      /^this chat has already downloaded its .*MB of gallery images$/,
    );
  });

  it('discards the downloaded files of a gallery that was not drawn', async () => {
    const service = new GalleryImageService(attachments, {
      download: () => Promise.resolve({ mediaType: 'image/png', bytes: PNG }),
    });
    const { gallery } = await service.localize(runId, {
      images: [
        { path: 'https://cdn.example/a.png' },
        { path: '/tmp/someone-elses.png' },
      ],
    });
    const downloaded = gallery!.images[0]!.path;

    service.discard(runId, gallery!);

    expect(existsSync(downloaded)).toBe(false);
    expect(existsSync(join(root, runId))).toBe(false);
  });

  it('refuses with the run budget, not a size, when too little of it is left', async () => {
    const service = new GalleryImageService(attachments, {
      maxRunBytes: PNG.length + 4,
      download: (_url, options) =>
        options!.maxBytes! < PNG.length
          ? Promise.reject(
              new RemoteImageError('larger than the 0MB a gallery downloads'),
            )
          : Promise.resolve({ mediaType: 'image/png', bytes: PNG }),
    });

    await service.localize(runId, {
      images: [{ path: 'https://cdn.example/a.png' }],
    });
    const { failures } = await service.localize(runId, {
      images: [{ path: 'https://cdn.example/b.png' }],
    });

    expect(failures[0]!.reason).toMatch(
      /^larger than what is left of this chat's .*MB of gallery downloads$/,
    );
  });

  it('refuses none of several small pictures that fit what is left of the budget', async () => {
    // Downloads in flight are not charged ahead, so four small pictures near
    // the cap all land rather than being refused for bytes they never used.
    const service = new GalleryImageService(attachments, {
      maxRunBytes: 15 * 1024 * 1024,
      download: () => Promise.resolve({ mediaType: 'image/png', bytes: PNG }),
    });

    const { gallery, failures } = await service.localize(runId, {
      images: ['a', 'b', 'c', 'd'].map((name) => ({
        path: `https://cdn.example/${name}.png`,
      })),
    });

    expect(failures).toEqual([]);
    expect(gallery?.images).toHaveLength(4);
  });
});
