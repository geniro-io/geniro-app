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

  it('answers null for both readings when the store holds nothing for the key', () => {
    const { pages } = service(null);

    expect(pages.page('run-1', 'plan', 1, 'wrong')).toBeNull();
    expect(pages.document('run-1', 'plan', 1, 'wrong')).toBeNull();
  });
});
