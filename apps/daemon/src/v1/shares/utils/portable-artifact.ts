import {
  ARTIFACT_LAYER_ORDER,
  atHeadStart,
  themeVar,
} from '../../agents/utils/artifact-runtime';
import type { ShareThemeVars } from '../shares.types';

/**
 * An artifact's stored document (`ArtifactPageService.document`) made ready to
 * be read with no geniro around it: the theme baked in, and links opening in a
 * new tab.
 *
 * The daemon twin of what `buildArtifactFile` (renderer `artifact-export.ts`)
 * adds to a saved file, minus the charset and policy, which the envelope page
 * carries instead.
 *
 * `vars` are the values the renderer computed for its current theme; without
 * them (an agent's share before any press) the tokens fall back to the
 * runtime's light defaults.
 */
export function buildPortableArtifact(
  document: string,
  vars: ShareThemeVars | null,
): string {
  const body = Object.entries(vars ?? {})
    // `<` could close the `<style>` it is written into, and a brace the
    // `:root` block, letting a value inject CSS into the shared page.
    .filter(([, value]) => !/[<{}]/.test(value))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  const theme =
    `<style data-geniro="theme">\n${ARTIFACT_LAYER_ORDER}\n:root {\n${body}\n}\n` +
    `@layer geniro-base { html, body { background: ${themeVar('bg')}; color: ${themeVar('fg')}; } }\n</style>`;
  // The page is framed sandboxed with popups allowed and nothing else, so a
  // link that navigated the frame itself would be refused by the policy and
  // look dead; a new tab is the one place a reader can follow it.
  return atHeadStart(document, `<base target="_blank">${theme}`);
}
