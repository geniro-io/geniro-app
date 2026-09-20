import { themeVars } from './artifact-theme';
import { exportBaseName } from './chat-export-name';
import type { PublishedArtifact } from './published-artifact';

/**
 * Where the theme block is injected, so the page's own rules can still win.
 *
 * Before `</head>` when there is one, because that is where a document's
 * styles belong and it keeps the block out of the rendered body. A document
 * without a head — an agent may write a bare fragment — gets it PREPENDED
 * instead of appended, which is not arbitrary: a custom property has to be
 * declared for `var()` to resolve it at paint, and declaring it first leaves a
 * page that sets `--geniro-*` on `:root` itself the last word, which is the
 * precedence a reader would expect.
 */
const HEAD_CLOSE = /<\/head\s*>/i;

/**
 * A `:root` block pinning the tokens an artifact reads to the values they have
 * RIGHT NOW.
 *
 * The framed page is handed these over `postMessage` by its host. A saved file
 * has no host — it is opened by a double-click, in whatever browser — so the
 * values have to be part of the document or every `var(--geniro-…)` in it
 * falls through to the page's own fallback. An agent that wrote fallbacks gets
 * a page in the wrong palette; one that did not gets black on black.
 *
 * Baking the CURRENT theme rather than a fixed light one is the whole point:
 * what the user sends is what they were looking at when they pressed save.
 */
function themeStyle(): string {
  const vars = themeVars();
  const body = Object.entries(vars)
    // A token whose value could carry a `<` would let a value close this very
    // element. Nothing in the palette does — they are colours and a font stack
    // — but the block is composed as markup, so the guard belongs here rather
    // than in a comment about what the values happen to be today.
    .filter(([, value]) => !value.includes('<'))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  // The GROUND, which the framed page never needs and a saved file cannot do
  // without. In the app the wrapper sets `html, body { background: transparent }`
  // and the card behind the frame supplies the colour; a file opened on its own
  // has nothing behind it, so it lands on the browser's default WHITE — and a
  // page saved under a dark theme is then near-white text on white. MEASURED by
  // opening a saved file in Chrome, which is the only place this is visible:
  // every rendering inside the app looks right either way.
  //
  // It is a BASE rather than an override: this block is injected before the
  // page's own styles, so a document that sets its own background still wins.
  const ground =
    'html, body { background: var(--geniro-bg); color: var(--geniro-fg); }';
  return `<style data-geniro="theme">\n:root {\n${body}\n}\n${ground}\n</style>\n`;
}

/**
 * The file name to suggest for a saved artifact — its TITLE, slugified, with
 * no extension (main appends `.html`).
 *
 * The title rather than the artifact id: the id is a slug the agent picked for
 * addressing the page across turns, while the title is what it called the
 * thing, and it is what the user has been reading on the card. The id is the
 * fallback for a title that slugifies to nothing.
 */
export function artifactFileName(artifact: PublishedArtifact): string {
  return exportBaseName(artifact.title, { fallback: artifact.artifactId });
}

/**
 * One published artifact as a standalone file.
 *
 * It is ONE file by construction rather than by effort: the page is served
 * under a CSP that allows no network and no external subresources, so anything
 * it draws is already inside it. There is no bundling step here and there is
 * no asset that could be left behind — which is exactly why "save as HTML" is
 * an honest offer for this card and would not be for an arbitrary web page.
 *
 * What it adds to the stored document is the theme, and nothing else. It does
 * NOT add geniro's frame wrapper: that is a `postMessage` handshake with an
 * embedder, so in a file opened on its own it is dead code listening for a
 * parent that will never speak — which is why this fetches the raw reading.
 */
export async function buildArtifactFile(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`artifact could not be read (${response.status})`);
  }
  const html = await response.text();
  const style = themeStyle();
  return HEAD_CLOSE.test(html)
    ? html.replace(HEAD_CLOSE, (close) => `${style}${close}`)
    : `${style}${html}`;
}
