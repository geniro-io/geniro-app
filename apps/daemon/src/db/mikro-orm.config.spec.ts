import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import config from './mikro-orm.config';

/**
 * The entity loader, driven with the exact shape mikro-orm hands it: a
 * `file://` URL. A real module on disk rather than a spy on `import()`, because
 * the defect was in what the PATH became — and only a real resolve can tell a
 * decoded path from one still carrying `%20`.
 */
describe('mikro-orm config — dynamicImportProvider', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir !== null) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it('loads a module whose path contains a space', async () => {
    // The shape of every task worktree: `~/Library/Application Support/…`.
    dir = await mkdtemp(join(tmpdir(), 'geniro orm spec '));
    const file = join(dir, 'probe.entity.mjs');
    await writeFile(file, 'export const marker = 42;\n');
    const load = config.dynamicImportProvider;
    if (load === undefined) {
      throw new Error('the config no longer provides its own entity loader');
    }

    const loaded = (await load(pathToFileURL(file).href)) as {
      marker?: number;
    };

    expect(loaded.marker).toBe(42);
  });
});
