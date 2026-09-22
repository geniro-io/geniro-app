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
 * `default-src 'none'` is the whole of it: no fetch, no XHR, no WebSocket, no
 * CDN script, no web font, no remote image, no beacon. The page can do whatever
 * it likes to itself and cannot say a word to anything else. The two
 * `'unsafe-inline'` grants are what the feature IS — an agent writes one file,
 * so its style and script are inline by construction — and they are safe here
 * only because the frame is an opaque origin with no network: there is nothing
 * for injected script to reach and nowhere for it to send anything.
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
 */
export const ARTIFACT_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
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
  color: var(--geniro-fg, #1a1a1a);
  font-family: var(--geniro-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
:root { color-scheme: light dark; }
a { color: var(--geniro-primary, #3b5bdb); }
`.trim();

/**
 * Where geniro's own block goes, if the document gave it a place to go.
 *
 * The LAST such tag, not the first — the negative lookahead is what makes it
 * last. A self-contained page routinely emits markup from its own script, or
 * shows HTML as its subject, so an earlier `</body>` can sit INSIDE a script
 * or a string literal; splicing the block there ends that script element on
 * the block's own closing tag and breaks the page, taking the wrapper down
 * with it.
 */
const BODY_CLOSE = /<\/body\s*>(?![\s\S]*<\/body\s*>)/i;

/**
 * One agent-authored document, wrapped for serving.
 *
 * The agent's html is passed through UNTOUCHED — not parsed, not sanitized, not
 * rewritten. That is deliberate and it is what the sandbox is for: trying to
 * clean HTML is a losing game played for decades, while an opaque origin with
 * `default-src 'none'` makes the question moot, because there is nothing the
 * page can reach whatever it contains.
 *
 * geniro's block is appended at the END rather than injected into `<head>`, for
 * two reasons. A model's document is frequently a fragment with no `<head>` at
 * all, so there may be nothing to inject into; and the wrapper has to run after
 * the page's own script has defined whatever it draws, or the first height it
 * reports is of an empty body. The base style still lands first in the CASCADE
 * despite being last in the document, because everything in it is either a
 * plain element selector the page can override or a `var()` fallback.
 */
export function renderArtifactPage(html: string): string {
  const block = `<style>${BASE_STYLE}</style><script>${WRAPPER_SCRIPT}</script>`;
  // A function replacer, so a `$&` or `$1` occurring in the agent's own styles
  // or script is not read as a replacement pattern.
  return BODY_CLOSE.test(html)
    ? html.replace(BODY_CLOSE, (close) => `${block}${close}`)
    : `${html}\n${block}`;
}
