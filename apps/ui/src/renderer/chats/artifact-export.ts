import { themeVars } from './artifact-theme';
import { exportBaseName } from './chat-export-name';
import type { PublishedArtifact } from './published-artifact';

/**
 * The Content-Security-Policy a saved page carries in its own `<meta>`.
 *
 * In the app the page is served with this policy as a response HEADER, and it
 * is the whole of what makes agent-written script safe to run: no network
 * beyond the fixed library CDNs, nothing to send anything to. A file opened by a
 * double-click has no response and therefore no header — so without this the
 * saved copy of a page ran with no policy at all, allowed everything the framed
 * one was refused. As a `<meta>` it governs only what comes AFTER it, which is
 * why it is the first thing in the head.
 *
 * TWIN PARSER: `ARTIFACT_PAGE_CSP` in
 * `apps/daemon/src/v1/agents/utils/artifact-page.ts`, restated because the
 * renderer imports no daemon source. A directive changed there must change
 * here, and `artifact-export.spec.ts` reads that file to fail the suite when
 * the two disagree.
 */
export const ARTIFACT_FILE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com",
  'img-src data:',
  'font-src data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com',
  'media-src data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * The cascade-layer order a saved page is given before anything else styles it.
 *
 * TWIN PARSER: `ARTIFACT_LAYER_ORDER` in
 * `apps/daemon/src/v1/agents/utils/artifact-runtime.ts`, restated because the
 * renderer imports no daemon source. `artifact-export.spec.ts` reads that file
 * and fails the suite when the two disagree — a different order here would
 * re-rank the kit against Tailwind in the saved file alone.
 */
export const ARTIFACT_LAYER_ORDER =
  '@layer theme, base, geniro-base, geniro, components, utilities;';

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
function themeCss(): string {
  const vars = themeVars();
  const body = Object.entries(vars)
    // A token whose value could carry a `<` could close this very element once
    // the file is parsed again — a `<style>`'s text is serialized raw. Nothing
    // in the palette does — they are colours and a font stack — but the guard
    // belongs here rather than in a comment about what the values are today.
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
  // It is a BASE rather than an override: this block is placed ahead of every
  // style the page carries, so a document that sets its own background — or its
  // own `--geniro-*` values — still wins. And it sits in the `geniro-base`
  // LAYER, as the framed page's own floor does: unlayered it would outrank every
  // layered rule, so a `<body class="bg-surface">` lost its Tailwind utility in
  // the saved file alone. The order statement is restated because this block
  // comes BEFORE the runtime's, and the first statement a document carries is
  // the order it gets.
  const ground =
    '@layer geniro-base { html, body { background: var(--geniro-bg); color: var(--geniro-fg); } }';
  return `\n${ARTIFACT_LAYER_ORDER}\n:root {\n${body}\n}\n${ground}\n`;
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
 * under a CSP whose only external subresources are libraries from fixed public
 * CDNs, so everything else it draws is already inside it. There is no bundling
 * step here and no asset of the page's own that could be left behind; a page
 * that loads a library from a CDN needs the network to draw, saved or framed.
 *
 * What it adds to the stored document is what a HOST would otherwise supply,
 * and nothing else: the policy the page is served under (`ARTIFACT_FILE_CSP`),
 * the theme, and the charset the file is written in. It does NOT add geniro's
 * frame wrapper: that is a `postMessage` handshake with an embedder, so in a
 * file opened on its own it is dead code listening for a parent that will
 * never speak — which is why this fetches the raw reading.
 *
 * The document is PARSED rather than spliced as text: a page that builds a
 * printable copy of itself carries a `</head>` inside a script, so a block
 * spliced in before the first one in the string lands in the middle of the
 * page's own code. A parser knows where the head is; a pattern cannot. What
 * that costs is byte-for-byte fidelity (the markup is re-serialized), never
 * content: a script's text is written back raw.
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
  // A parsed document runs nothing: a DOMParser document has scripting
  // disabled, so the agent's code is carried, never executed, here.
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // The charset FIRST, because a browser looks for it only in the first bytes
  // of the file and what follows pushes the page's own declaration further in.
  // Main writes the file as UTF-8 whatever the page claimed, so that is the
  // truth to declare, and a second, older declaration would only contradict it.
  for (const stale of doc.head.querySelectorAll('meta[charset]')) {
    stale.remove();
  }
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');

  const policy = doc.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', ARTIFACT_FILE_CSP);

  const theme = doc.createElement('style');
  theme.setAttribute('data-geniro', 'theme');
  theme.textContent = themeCss();

  // Ahead of everything the page put in its head: the policy governs only
  // what follows it, and the theme is a base the page's own styles override.
  doc.head.prepend(charset, policy, theme);
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}
