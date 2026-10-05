import {
  ARTIFACT_THEME_EVENT,
  themeVar,
  withArtifactRuntime,
} from './artifact-runtime';

/**
 * The Content-Security-Policy the artifact page carries as its OWN response
 * header — the thing that makes agent-authored script safe to run at all.
 *
 * This is NOT the renderer's policy and does not inherit from it. A framed
 * document's policy comes from its own response headers, which is precisely why
 * the page is served over loopback rather than put in an `<iframe srcdoc>`: a
 * srcdoc document INHERITS the embedder's policy, and the app's is
 * `default-src 'self'` with no `script-src`, so the agent's script would simply
 * never run.
 *
 * `default-src 'none'` is the base: no fetch, no XHR, no WebSocket, no remote
 * image, no beacon, no frame. The two `'unsafe-inline'` grants are what the
 * feature IS — an agent writes one file, so its style and script are inline by
 * construction.
 *
 * The one way OUT is a fixed list of public library CDNs — scripts,
 * stylesheets and fonts only — plus Google Fonts. That is what lets a page draw
 * with ECharts, Mermaid or Tailwind instead of hand-rolled SVG, and it is the
 * list Claude Code's own artifacts allow, so an agent's habits carry over. The
 * price is that such a page does not work offline, which is the user's call.
 * It opens no channel to talk BACK: script still cannot `fetch`, and a library
 * from a CDN runs under the same `connect-src` silence as the page's own code.
 * The page URL carries the per-artifact key, which is why the route also sends
 * `Referrer-Policy: no-referrer` — without it every CDN request would log it.
 * The hosts are spelled out in each directive rather than shared through a
 * constant because the twin parser reads string literals.
 *
 * `frame-ancestors` is deliberately ABSENT. The embedder is this app's own
 * renderer, whose origin is `file://` in a packaged build and a dev-server URL
 * under `pnpm dev`; naming either would break the other, and a wrong value
 * breaks the feature outright rather than degrading. What actually keeps the
 * page private is the per-artifact key — 256 bits, minted by the store, never
 * in argv or a log — so a page that cannot be addressed cannot be framed.
 *
 * `base-uri` and `form-action` are pinned to `'none'` because `default-src`
 * does not cover them: without the first, a `<base>` tag could re-point every
 * relative URL in the document, and without the second a form could POST the
 * page's contents somewhere even though script cannot.
 *
 * TWIN PARSER: `ARTIFACT_FILE_CSP` in
 * `apps/ui/src/renderer/chats/artifact-export.ts` restates this policy as the
 * `<meta>` a SAVED copy of the page carries — a file has no response header,
 * and the renderer cannot import daemon source. A directive changed here must
 * change there; `artifact-export.spec.ts` reads this array out of this file
 * and fails when the two disagree, so keep it one string literal per line.
 *
 * TWIN PARSER: `ARTIFACT_CDN_HOSTS` in `apps/ui/src/main/network-lockdown.ts`
 * — the Electron main process refuses every other host at the resolver and
 * the proxy, so a host added here and not there never loads in the app.
 * `network-lockdown.spec.ts` reads this array too.
 */
export const ARTIFACT_PAGE_CSP = [
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
 * The message `source` tags on this channel.
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/artifact-frame.tsx — the host half of
 * the same two messages. There is no generated type for a `postMessage`
 * payload, so these two files are the whole contract; a field added to one must
 * be added to the other.
 */
export const ARTIFACT_HOST_SOURCE = 'geniro-host';
export const ARTIFACT_FRAME_SOURCE = 'geniro-artifact';

/**
 * geniro's own script inside the page — the only code here the agent did not
 * write, and it does exactly two things.
 *
 * It APPLIES the theme: the host posts the resolved values of its own tokens
 * and this writes them onto `documentElement`, so a page that reached for
 * `var(--geniro-fg)` is painted in the user's actual theme and follows it when
 * they switch. The values have to arrive by message rather than be baked into
 * the response, because the daemon cannot read the renderer's stylesheets —
 * the token VALUES live in CSS files that only the renderer has parsed.
 *
 * And it REPORTS its height, so the frame can be sized to its content instead
 * of scrolling inside a box. `ResizeObserver` covers the case a load event
 * cannot: a page whose own script draws after first paint, which is most of
 * the interesting ones.
 *
 * Once the theme is written it fires `ARTIFACT_THEME_EVENT` on `window`, which
 * is how the page runtime (`artifact-runtime.ts`) knows to re-theme the charts
 * and diagrams it drew with the previous values.
 *
 * It accepts a message only from its own parent (`event.source === parent`).
 * Nothing secret travels either way — colours out, a pixel height back — so
 * this is about a stray message from another frame confusing the page, not
 * about secrecy.
 */
const WRAPPER_SCRIPT = `
(function () {
  var root = document.documentElement;
  var last = -1;
  function report() {
    var body = document.body;
    var height = Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      root.scrollHeight
    );
    if (height === last) return;
    last = height;
    parent.postMessage(
      { source: ${JSON.stringify(ARTIFACT_FRAME_SOURCE)}, type: 'height', height: height },
      '*'
    );
  }
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.source !== ${JSON.stringify(ARTIFACT_HOST_SOURCE)}) return;
    if (data.type === 'theme' && data.vars) {
      for (var name in data.vars) {
        try {
          root.style.setProperty(name, String(data.vars[name]));
        } catch (err) {
          /* a token the page cannot take is not worth failing the page over */
        }
      }
      window.dispatchEvent(new Event(${JSON.stringify(ARTIFACT_THEME_EVENT)}));
      report();
    }
  });
  window.addEventListener('load', report);
  window.addEventListener('resize', report);
  if (typeof ResizeObserver === 'function') {
    var observe = function () {
      if (document.body) new ResizeObserver(report).observe(document.body);
      report();
    };
    if (document.body) observe();
    else window.addEventListener('DOMContentLoaded', observe);
  }
  parent.postMessage(
    { source: ${JSON.stringify(ARTIFACT_FRAME_SOURCE)}, type: 'ready' },
    '*'
  );
})();
`.trim();

/**
 * The base styling every artifact starts from.
 *
 * Transparent rather than white, which is the one line that makes an artifact
 * look like part of the app instead of a document pasted into it: the frame
 * shows the app's own background through, so a page that sets none inherits the
 * user's theme. A page that sets its own still wins — this is a floor, not a
 * policy.
 *
 * Every value is a `var(--geniro-*)` with a fallback, so the page is legible
 * before the host's theme message arrives and if it never does.
 *
 * The two RESET lines are the only rules here that are not about colour, and
 * they are floors against the two ways an agent's page routinely overflows its
 * frame: a width plus padding measured content-box, and an image wider than the
 * column. Both are what every modern stylesheet already declares, so a page
 * that sets them itself sets the same values; a page that forgot them is the
 * one this catches. Everything else about how a page LOOKS is the agent's, and
 * is asked for where the agent can act on it — the `show_artifact` tool's own
 * description — rather than legislated here, since a page's own CSS wins by
 * construction and a floor cannot reach inside its markup.
 */
const BASE_STYLE = `
html, body { background: transparent; }
*, *::before, *::after { box-sizing: border-box; }
img, svg, video, canvas { max-width: 100%; }
body {
  margin: 0;
  padding: 16px;
  color: ${themeVar('fg')};
  font-family: ${themeVar('font')};
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
:root { color-scheme: light dark; }
a { color: ${themeVar('primary')}; }
`.trim();

/**
 * Where geniro's own block goes, if the document gave it a place to go.
 *
 * The LAST such tag, not the first — the negative lookahead is what makes it
 * last. An agent's page routinely emits markup from its own script, or
 * shows HTML as its subject, so an earlier `</body>` can sit INSIDE a script
 * or a string literal; splicing the block there ends that script element on
 * the block's own closing tag and breaks the page, taking the wrapper down
 * with it.
 */
const BODY_CLOSE = /<\/body\s*>(?![\s\S]*<\/body\s*>)/i;

/**
 * One agent-authored document, wrapped for serving.
 *
 * The agent's markup is never parsed, sanitized or rewritten — geniro only
 * splices its own blocks in beside it. That is deliberate and it is what the
 * sandbox is for: trying to clean HTML is a losing game played for decades,
 * while an opaque origin under `ARTIFACT_PAGE_CSP` makes the question moot —
 * the page can load libraries from the fixed CDNs and open no channel of its
 * own, whatever it contains.
 *
 * geniro's block is appended at the END rather than injected into `<head>`, for
 * two reasons. A model's document is frequently a fragment with no `<head>` at
 * all, so there may be nothing to inject into; and the wrapper has to run after
 * the page's own script has defined whatever it draws, or the first height it
 * reports is of an empty body. The base style still lands first in the CASCADE
 * despite being last in the document, because it sits in a cascade layer below
 * everything the page, the kit or Tailwind writes.
 *
 * The page RUNTIME is the exception and goes in FRONT (`withArtifactRuntime`):
 * it defines helpers the page's own script calls, so it has to exist first.
 */
export function renderArtifactPage(html: string): string {
  const withRuntime = withArtifactRuntime(html);
  // In the `geniro-base` layer (ARTIFACT_LAYER_ORDER): above Tailwind's reset,
  // below the kit and Tailwind's utilities, so both outrank this floor and the
  // page's own unlayered CSS outranks all of it.
  const block = `<style>@layer geniro-base {\n${BASE_STYLE}\n}</style><script>${WRAPPER_SCRIPT}</script>`;
  // A function replacer, so a `$&` or `$1` occurring in the agent's own styles
  // or script is not read as a replacement pattern.
  return BODY_CLOSE.test(withRuntime)
    ? withRuntime.replace(BODY_CLOSE, (close) => `${block}${close}`)
    : `${withRuntime}\n${block}`;
}

/**
 * The agent's document for a saved file: with the page runtime its script
 * calls, and without the frame wrapper, which is a handshake with an embedder a
 * file opened on its own will never have.
 */
export function renderArtifactDocument(html: string): string {
  return withArtifactRuntime(html);
}
