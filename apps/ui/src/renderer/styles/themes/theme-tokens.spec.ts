import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { THEMES } from '../../../shared/themes';

const THEMES_DIR = __dirname;
const GLOBAL_CSS = join(THEMES_DIR, '../global.css');

/**
 * A token declared in one theme and forgotten in another does not fail — it
 * falls through to the `:root` arm in `light.css` and paints a light value
 * into a dark window, on one control, which is exactly the kind of thing an
 * eye sweeping six screens misses. Nothing else in the project can catch it:
 * jsdom computes no CSS cascade, so no component spec can observe a token's
 * resolved value.
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function themeCss(file: string): string {
  return readFileSync(join(THEMES_DIR, file), 'utf8');
}

function declaredTokens(file: string): Set<string> {
  return new Set(
    [...stripComments(themeCss(file)).matchAll(/(--[a-z0-9-]+)\s*:/g)].flatMap(
      (match) => (match[1] === undefined ? [] : [match[1]]),
    ),
  );
}

const themeFiles = readdirSync(THEMES_DIR)
  .filter((name) => name.endsWith('.css'))
  .sort();

describe('theme token files', () => {
  it('ships more than one theme, so the parity check below has something to compare', () => {
    expect(themeFiles.length).toBeGreaterThan(1);
  });

  const light = declaredTokens('light.css');

  it.each(themeFiles.filter((name) => name !== 'light.css'))(
    '%s declares every token light.css declares',
    (file) => {
      const missing = [...light].filter(
        (token) => !declaredTokens(file).has(token),
      );

      expect(missing).toEqual([]);
    },
  );

  it.each(themeFiles.filter((name) => name !== 'light.css'))(
    '%s declares no token light.css lacks',
    (file) => {
      // The reverse direction matters just as much: a token only one theme
      // knows about has no value at all under the others.
      const orphans = [...declaredTokens(file)].filter(
        (token) => !light.has(token),
      );

      expect(orphans).toEqual([]);
    },
  );

  it('gives light.css the bare :root arm, so an unresolved theme still has a palette', () => {
    // The SELECTOR LIST, not its formatting — collapsing it onto one line is a
    // legal prettier result and changes nothing about the cascade.
    expect(stripComments(themeCss('light.css'))).toMatch(
      /:root\s*,\s*\[data-theme='light'\]/,
    );
  });

  it.each(THEMES)(
    '$id declares the color-scheme its manifest row claims',
    (theme) => {
      // Driven off the manifest rather than accepting either value: a dark
      // theme declaring `color-scheme: light` gives white native scrollbars,
      // form controls and caret inside a dark window, and jsdom can catch that
      // nowhere else.
      expect(stripComments(themeCss(`${theme.id}.css`))).toMatch(
        new RegExp(`color-scheme:\\s*${theme.appearance}\\s*;`),
      );
    },
  );

  it.each(THEMES)('$id is imported by global.css', (theme) => {
    // The third edit adding a theme needs, and the one that fails SILENTLY:
    // the file exists and the manifest row matches it, so both checks above
    // pass, while at runtime the selector matches nothing and the document
    // falls through to light.css's `:root` arm — the picker offers a theme
    // that paints the light palette.
    expect(readFileSync(GLOBAL_CSS, 'utf8')).toContain(
      `@import './themes/${theme.id}.css';`,
    );
  });

  it('imports light.css first, so its :root arm cannot outrank a theme block', () => {
    // Equal specificity — `:root` and `[data-theme='…']` are both (0,1,0) — so
    // source order is the whole of the cascade here. A theme imported ABOVE
    // light.css loses to the fallback on every token.
    const css = readFileSync(GLOBAL_CSS, 'utf8');
    const lightAt = css.indexOf(`@import './themes/light.css';`);

    for (const theme of THEMES.filter(
      (candidate) => candidate.id !== 'light',
    )) {
      expect(
        css.indexOf(`@import './themes/${theme.id}.css';`),
      ).toBeGreaterThan(lightAt);
    }
  });

  it('maps every semantic colour token through @theme inline', () => {
    // The other half of "adding a token": a token declared in every theme file
    // but absent from the `@theme inline` map emits no `--color-*` utility, so
    // `bg-newthing` silently produces nothing.
    const inline = /@theme inline\s*\{([\s\S]*?)\n\}/.exec(
      readFileSync(GLOBAL_CSS, 'utf8'),
    )?.[1];
    if (inline === undefined) {
      throw new Error('no @theme inline block in global.css');
    }

    const mapped = new Set(
      [...inline.matchAll(/var\((--[a-z0-9-]+)\)/g)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      ),
    );
    // Exactly the tokens `@layer base` reads as `var(--…)` and no utility
    // exposes — `--font-size` on html, the two weights on the heading rules.
    // Anything else that is genuinely mapped needs no entry here, and a
    // too-generous list is how this check quietly stops checking: with the
    // six mapped tokens that used to be listed, deleting
    // `--shadow-panel-lg: var(--shadow-lg)` from `@theme inline` left the
    // suite green while every floating panel lost its shadow.
    const consumedDirectly = [
      '--font-size',
      '--font-weight-medium',
      '--font-weight-normal',
    ];
    const unmapped = [...light].filter(
      (token) => !mapped.has(token) && !consumedDirectly.includes(token),
    );

    expect(unmapped).toEqual([]);
  });

  it.each(THEMES)('$id declares its own [data-theme] selector', (theme) => {
    // The other half of the silent failure the import check covers: file
    // present, manifest row matching, import present — and the block keyed to
    // a typo'd id, so it matches nothing and the document falls through to
    // light.css's `:root` arm.
    expect(stripComments(themeCss(`${theme.id}.css`))).toMatch(
      new RegExp(`\\[data-theme='${theme.id}'\\]`),
    );
  });
});
