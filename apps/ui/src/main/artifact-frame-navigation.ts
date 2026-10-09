import type { WebContents } from 'electron';

/**
 * The daemon route published artifact pages are served from.
 *
 * TWIN PARSER: `ArtifactsController` (`@Controller('v1/artifacts')`) serves it, and
 * the renderer's `artifactPageUrl` builds the URL the frame loads. A route renamed
 * on one side leaves every artifact frame refused here. There is no generated type
 * for a URL path, so the three files are the whole contract.
 */
const ARTIFACT_ROUTE_PREFIX = '/v1/artifacts/';

/**
 * Whether a subframe of the app window may navigate to `targetUrl`: only to an
 * artifact page served by the daemon at `daemonOrigin`, over plain http, which
 * is all the daemon speaks on loopback. With no daemon up (`null`) nothing is
 * admitted.
 *
 * Neither the artifact frame's sandbox nor its CSP stops a link inside it from
 * navigating the frame itself, so this is what keeps it on its page.
 *
 * It judges the parsed URL. Matching the raw string admits
 * `http://127.0.0.1:47615@evil.example/` (the origin is `evil.example`) and
 * `/v1/artifacts/../chats/` (the path is `/v1/chats/`).
 */
export function isAllowedArtifactFrameNavigation(
  targetUrl: string,
  daemonOrigin: string | null,
): boolean {
  if (daemonOrigin === null) {
    return false;
  }
  try {
    const target = new URL(targetUrl);
    return (
      target.protocol === 'http:' &&
      target.origin === daemonOrigin &&
      target.pathname.startsWith(ARTIFACT_ROUTE_PREFIX)
    );
  } catch {
    return false;
  }
}

/**
 * Keeps every subframe of `contents` on an artifact page. The window's only
 * subframe is an artifact frame, so the guard judges nothing else; the main
 * frame stays with the top-frame guards in `index.ts`.
 */
export function guardArtifactFrameNavigations(
  contents: Pick<WebContents, 'on'>,
  daemonOriginNow: () => string | null,
): void {
  contents.on('will-frame-navigate', (event) => {
    if (
      !event.isMainFrame &&
      !isAllowedArtifactFrameNavigation(event.url, daemonOriginNow())
    ) {
      event.preventDefault();
    }
  });
}
