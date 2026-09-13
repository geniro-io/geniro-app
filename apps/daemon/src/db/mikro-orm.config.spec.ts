import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { entityImportPath } from './mikro-orm.config';

describe('entityImportPath', () => {
  it('decodes a file URL whose path has a space in it', () => {
    // Stripping the scheme left `%20` in place, and require() then looked for a
    // directory literally named `Application%20Support`.
    const path = '/Users/me/Library/Application Support/app/run.entity.js';

    expect(entityImportPath(pathToFileURL(path).href)).toBe(path);
  });

  it('passes a plain path through untouched', () => {
    expect(entityImportPath('/opt/app/run.entity.js')).toBe(
      '/opt/app/run.entity.js',
    );
  });
});
