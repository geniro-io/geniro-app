import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_UI_MEDIA_PER_CALL } from '../chat.types';
import type { RunDao } from '../dao/run.dao';
import { type A2uiComponent, A2uiError } from '../utils/a2ui/a2ui-validate';
import { RemoteImageError } from '../utils/remote-image';
import { AttachmentStoreService } from './attachment-store.service';
import { RunDownloadBudget } from './run-download-budget.service';
import {
  type SurfaceMediaOptions,
  SurfaceMediaService,
} from './surface-media.service';

const MB = 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')]);
const URL_OF_CLIP = 'https://cdn.example/clip.mp4';

let root: string;
let runFolder: string;
let runId: string;
let runs: RunDao;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'surface-media-store-'));
  runFolder = mkdtempSync(join(tmpdir(), 'surface-media-run-'));
  runId = randomUUID();
  runs = {
    getById: () => Promise.resolve({ cwd: runFolder }),
  } as unknown as RunDao;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(runFolder, { recursive: true, force: true });
});

function media(
  options: { download?: unknown; budget?: RunDownloadBudget } = {},
): SurfaceMediaService {
  const download = (options.download ??
    (() =>
      Promise.reject(
        new RemoteImageError('no download was expected'),
      ))) as SurfaceMediaOptions['download'];
  return new SurfaceMediaService(
    new AttachmentStoreService({ root }),
    options.budget ?? new RunDownloadBudget(),
    runs,
    { download },
  );
}

function entry(
  component: A2uiComponent,
  position: number,
): { component: A2uiComponent; pointer: string } {
  return {
    component,
    pointer: `/messages/0/createSurface/components/${position}`,
  };
}

function storedFiles(): string[] {
  const dir = join(root, runId);
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe('SurfaceMediaService.localize', () => {
  it('stores a local picture under the run folder and names it by its stored copy', async () => {
    const picture = join(runFolder, 'chart.png');
    writeFileSync(picture, PNG);

    const result = await media().localize(runId, [
      entry({ id: 'pic', component: 'Image', url: picture }, 0),
    ]);

    const url = String(result.components[0]?.url);
    expect(url).toMatch(/^geniro-media:ui-[0-9a-f-]{36}\.png$/);
    const file = url.slice('geniro-media:'.length);
    expect(result.media).toEqual({
      [file]: { mediaType: 'image/png', source: picture },
    });
    expect(existsSync(join(root, runId, file))).toBe(true);
  });

  it('refuses a local file outside the run folder and the temp folders', async () => {
    const outside = join(process.cwd(), 'package.json');

    await expect(
      media().localize(runId, [
        entry({ id: 'pic', component: 'Image', url: outside }, 0),
      ]),
    ).rejects.toMatchObject({
      pointer: '/messages/0/createSurface/components/0/url',
    });
    expect(storedFiles()).toEqual([]);
  });

  it('refuses a file given to a video that is not a video, whatever its name', async () => {
    const clip = join(runFolder, 'clip.mp4');
    writeFileSync(clip, 'this is not a video');

    await expect(
      media().localize(runId, [
        entry({ id: 'v', component: 'Video', url: clip }, 0),
      ]),
    ).rejects.toThrow('is not an mp4, webm or ogg video');
  });

  it('refuses a local video over the size cap, naming its size, and stores nothing', async () => {
    const long = join(runFolder, 'long.mp4');
    writeFileSync(long, MP4);
    truncateSync(long, 60 * MB);

    await expect(
      media().localize(runId, [
        entry({ id: 'v', component: 'Video', url: long }, 0),
      ]),
    ).rejects.toThrow(/is 60MB, over the 50MB/);
    expect(storedFiles()).toEqual([]);
  });

  it('downloads a video URL as a video, capped by what is left of the run budget', async () => {
    const download = vi.fn(async () => ({
      mediaType: 'mp4',
      bytes: Buffer.alloc(1000, 1),
    }));
    const budget = new RunDownloadBudget(20 * MB);

    const result = await media({ download, budget }).localize(runId, [
      entry({ id: 'v', component: 'Video', url: URL_OF_CLIP }, 0),
    ]);

    expect(download).toHaveBeenCalledWith(
      URL_OF_CLIP,
      expect.objectContaining({ accept: 'video/*' }),
      expect.objectContaining({ maxBytes: 20 * MB }),
    );
    const url = String(result.components[0]?.url);
    const file = url.slice('geniro-media:'.length);
    expect(file).toMatch(/\.mp4$/);
    expect(result.media[file]).toEqual({
      mediaType: 'video/mp4',
      source: URL_OF_CLIP,
    });
    expect(budget.left(runId)).toBe(20 * MB - 1000);
  });

  it('refuses a download once the run has used its whole budget, without fetching', async () => {
    const download = vi.fn(async () => ({ mediaType: 'mp4', bytes: MP4 }));
    const budget = new RunDownloadBudget(2 * MB);
    budget.charge(runId, 2 * MB);

    await expect(
      media({ download, budget }).localize(runId, [
        entry({ id: 'v', component: 'Video', url: URL_OF_CLIP }, 0),
      ]),
    ).rejects.toThrow('already downloaded');
    expect(download).not.toHaveBeenCalled();
  });

  it('stores a URL named twice in one call once', async () => {
    const url = 'https://cdn.example/picture.png';
    const download = vi.fn(async () => ({ mediaType: 'png', bytes: PNG }));

    const result = await media({ download }).localize(runId, [
      entry({ id: 'a', component: 'Image', url }, 0),
      entry({ id: 'b', component: 'Image', url }, 1),
    ]);

    expect(download).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.media)).toHaveLength(1);
    expect(result.components[0]?.url).toBe(result.components[1]?.url);
    expect(storedFiles()).toHaveLength(1);
  });

  it('removes the file it already stored when a later media file fails', async () => {
    const first = 'https://cdn.example/first.png';
    const second = 'https://cdn.example/second.png';
    const download = vi.fn(async (url: string) => {
      if (url === second) {
        throw new RemoteImageError('the server answered HTTP 500');
      }
      return { mediaType: 'png', bytes: PNG };
    });

    await expect(
      media({ download }).localize(runId, [
        entry({ id: 'a', component: 'Image', url: first }, 0),
        entry({ id: 'b', component: 'Image', url: second }, 1),
      ]),
    ).rejects.toBeInstanceOf(A2uiError);
    expect(download).toHaveBeenCalledTimes(2);
    expect(storedFiles()).toEqual([]);
  });

  it('refuses more media files in one call than the per-call cap', async () => {
    const download = vi.fn(async () => ({ mediaType: 'png', bytes: PNG }));
    const entries = Array.from(
      { length: MAX_UI_MEDIA_PER_CALL + 1 },
      (_, index) =>
        entry(
          {
            id: `p${index}`,
            component: 'Image',
            url: `https://cdn.example/${index}.png`,
          },
          index,
        ),
    );

    await expect(media({ download }).localize(runId, entries)).rejects.toThrow(
      `one call stores at most ${MAX_UI_MEDIA_PER_CALL} media files`,
    );
    expect(storedFiles()).toEqual([]);
  });
});

describe('SurfaceMediaService.localize — the run budget', () => {
  it('charges the run budget with the bytes of a local picture it copies', async () => {
    const picture = join(runFolder, 'chart.png');
    writeFileSync(picture, PNG);
    const budget = new RunDownloadBudget(20 * MB);

    await media({ budget }).localize(runId, [
      entry({ id: 'pic', component: 'Image', url: picture }, 0),
    ]);

    expect(budget.left(runId)).toBe(20 * MB - PNG.length);
  });

  it('refuses a local file larger than what is left of the run budget, and stores nothing', async () => {
    const picture = join(runFolder, 'big.png');
    writeFileSync(picture, Buffer.concat([PNG, Buffer.alloc(20)]));
    const budget = new RunDownloadBudget(10);

    await expect(
      media({ budget }).localize(runId, [
        entry({ id: 'pic', component: 'Image', url: picture }, 0),
      ]),
    ).rejects.toThrow("larger than what is left of this chat's");
    expect(storedFiles()).toEqual([]);
    expect(budget.left(runId)).toBe(10);
  });
});
