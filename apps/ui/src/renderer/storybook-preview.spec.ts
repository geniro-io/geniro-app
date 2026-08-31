import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The catalog's preview harness, pinned where nothing else can catch it.
 *
 * `preview.tsx` is Storybook's counterpart to `main.tsx` — hence a spec beside
 * that one — and it carries an ordering that is load-bearing and invisible to
 * every other gate. Storybook imports the preview, then every story file, and
 * through them every component module; a module that reads `window.geniro`
 * while being imported throws unless the stub is already installed.
 *
 * Nothing in CI runs Storybook, so build, check-types, lint and the unit suite
 * all stay green while the catalog is broken for everyone who opens it. That
 * gap is why these belong in a spec rather than in a comment.
 *
 * The ordering is not currently fragile — `simple-import-sort` groups
 * side-effect imports first and preserves their mutual order, and no module
 * under `components/**` reads the bridge at import time. Both of those are
 * facts about today's tooling and today's components, which is exactly the
 * kind of thing a test is for.
 */

const PREVIEW = join(__dirname, '../../.storybook/preview.tsx');
const STUB_SPECIFIER = './mocks/install-preload';

/** Every import specifier in source order. */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].flatMap(
    (match) => (match[1] === undefined ? [] : [match[1]]),
  );
}

describe('the Storybook preview harness', () => {
  const source = readFileSync(PREVIEW, 'utf8');

  it('reads a preview that actually imports something', () => {
    // Without this, a moved or renamed preview file makes every check below
    // vacuously true rather than failing.
    expect(importSpecifiers(source).length).toBeGreaterThan(1);
  });

  it('installs the preload stub before any other import', () => {
    // Reverting this — moving the stub import down, or letting an import sorter
    // do it — is what this assertion exists to fail on.
    expect(importSpecifiers(source)[0]).toBe(STUB_SPECIFIER);
  });

  it('drives the app’s own theme writer rather than setting data-theme itself', () => {
    // `apply-theme.ts` keeps the resolved theme in module state that
    // `useThemeAppearance()` reads, so a decorator writing the attribute
    // directly would paint the right palette while leaving that hook — and the
    // md-editor surface built on it — reporting the previous theme.
    expect(source).toContain('setThemePreference');
    expect(source).not.toMatch(/dataset\.theme\s*=/);
    expect(source).not.toMatch(/setAttribute\(\s*['"]data-theme['"]/);
  });
});
