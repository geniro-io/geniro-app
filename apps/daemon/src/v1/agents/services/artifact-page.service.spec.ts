import { describe, expect, it, vi } from 'vitest';

import { ARTIFACT_HOST_SOURCE } from '../utils/artifact-page';
import { ArtifactPageService } from './artifact-page.service';
import type { ArtifactStoreService } from './artifact-store.service';

const STORED = '<head></head><p>x</p><script>geniro.chart("#a", {})</script>';

function service(stored: string | null): {
  pages: ArtifactPageService;
  read: ReturnType<typeof vi.fn>;
} {
  const read = vi.fn(() => stored);
  const store = { read } as unknown as ArtifactStoreService;
  return { pages: new ArtifactPageService(store), read };
}

describe('ArtifactPageService', () => {
  it('frames the page with the runtime in front and the wrapper behind', () => {
    const { pages, read } = service(STORED);

    const page = pages.page('run-1', 'plan', 2, 'key');

    expect(read).toHaveBeenCalledWith('run-1', 'plan', 2, 'key');
    const runtime = page!.indexOf('data-geniro="runtime"');
    const content = page!.indexOf('<p>x</p>');
    const wrapper = page!.indexOf(ARTIFACT_HOST_SOURCE);
    expect(runtime).toBeGreaterThan(-1);
    expect(runtime).toBeLessThan(content);
    expect(content).toBeLessThan(wrapper);
  });

  it('gives the saved-file reading the runtime its script calls, and no wrapper', () => {
    // Without the runtime a saved page throws on its first `geniro.chart`.
    const { pages } = service(STORED);

    const doc = pages.document('run-1', 'plan', 2, 'key');

    expect(doc).toContain('data-geniro="runtime"');
    expect(doc).toContain('<p>x</p>');
    expect(doc).not.toContain(ARTIFACT_HOST_SOURCE);
  });

  it('writes each stored picture into the page as a data URI, read under the page’s own key', () => {
    const hash = 'a'.repeat(64);
    const stored = `<img src="images/${hash}.png"><img src="https://example.com/x.png"><img src="images/notes.txt">`;
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const readImage = vi.fn(() => ({ mediaType: 'image/png', bytes }));
    const pages = new ArtifactPageService({
      read: () => stored,
      readImage,
    } as unknown as ArtifactStoreService);

    const page = pages.page('run-1', 'plan', 1, 'the key');

    expect(readImage).toHaveBeenCalledWith(
      'run-1',
      'plan',
      'the key',
      `${hash}.png`,
    );
    expect(page).toContain(
      `src="data:image/png;base64,${bytes.toString('base64')}"`,
    );
    // A reference that is not one of this store's images is left as written,
    // and is never looked up at all.
    expect(page).toContain('src="https://example.com/x.png"');
    expect(page).toContain('src="images/notes.txt"');
    expect(readImage).toHaveBeenCalledTimes(1);
  });

  it('gives the saved document its pictures too, so the file stands alone', () => {
    const hash = 'b'.repeat(64);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const pages = new ArtifactPageService({
      read: () => `<img src="images/${hash}.png">`,
      readImage: () => ({ mediaType: 'image/png', bytes }),
    } as unknown as ArtifactStoreService);

    const doc = pages.document('run-1', 'plan', 1, 'the key');

    expect(doc).toContain(
      `src="data:image/png;base64,${bytes.toString('base64')}"`,
    );
    expect(doc).not.toContain('images/');
  });

  it('answers null for both readings when the store holds nothing for the key', () => {
    const { pages } = service(null);

    expect(pages.page('run-1', 'plan', 1, 'wrong')).toBeNull();
    expect(pages.document('run-1', 'plan', 1, 'wrong')).toBeNull();
  });
});
