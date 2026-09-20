import { useCallback, useContext, useEffect, useRef, useState } from 'react';

import { cn } from '../components/ui/utils';
import { useThemeAppearance } from '../theme/apply-theme';
import { themeVars } from './artifact-theme';
import {
  ArtifactUrlContext,
  type PublishedArtifact,
} from './published-artifact';

/** The message `source` tags — see the daemon's `utils/artifact-page.ts`. */
const HOST_SOURCE = 'geniro-host';
const FRAME_SOURCE = 'geniro-artifact';

/** Where a frame starts before its page has reported anything. */
const INITIAL_HEIGHT = 240;

/**
 * How tall an INLINE frame may grow. The popup lets the page fill the dialog
 * instead, so one artifact can never take over the transcript.
 */
const MAX_INLINE_HEIGHT = 520;

/**
 * One published artifact, rendered in a sandbox.
 *
 * **The `sandbox` attribute is the whole security model, and what it OMITS is
 * the load-bearing part.** `allow-scripts` without `allow-same-origin` puts the
 * document in an opaque origin: it cannot read this app's DOM, its storage, or
 * the loopback token the renderer holds, and `document.domain` games get it
 * nowhere. The two flags must never appear together — a frame granted both can
 * reach into its own `sandbox` attribute and remove it, which is the documented
 * way this protection is undone. The page's own response then adds
 * `default-src 'none'`, so it has no network either (see `ARTIFACT_PAGE_CSP`).
 *
 * It is a `src` rather than an `srcdoc` because a srcdoc document inherits the
 * embedder's CSP — see {@link ARTIFACT_PAGE_CSP} in the daemon's
 * `utils/artifact-page.ts` for what that would cost.
 *
 * The frame SIZES ITSELF from the height its page reports, because an artifact
 * is a document of unknown length and a fixed box would put a scrollbar inside
 * a scrollbar. `contentWindow` identity is what messages are filtered on —
 * the frame's origin is the string `"null"` for every opaque-origin document,
 * so it identifies nothing.
 */
export function ArtifactFrame({
  artifact,
  className,
  fill = false,
}: {
  artifact: PublishedArtifact;
  className?: string;
  /** Take the room the container gives, rather than sizing to the content. */
  fill?: boolean;
}): React.JSX.Element {
  const urlFor = useContext(ArtifactUrlContext);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  // Re-sent on a theme change: the page holds whatever it was last given, so
  // without this an artifact stays in the palette it was opened under.
  const appearance = useThemeAppearance();

  const postTheme = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      { source: HOST_SOURCE, type: 'theme', vars: themeVars() },
      // The frame is an opaque origin, which has no origin string to target.
      // Nothing secret travels — colours out, a pixel height back.
      '*',
    );
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) {
        return;
      }
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) {
        return;
      }
      const message = data as {
        source?: unknown;
        type?: unknown;
        height?: unknown;
      };
      if (message.source !== FRAME_SOURCE) {
        return;
      }
      if (message.type === 'ready') {
        postTheme();
        return;
      }
      if (message.type === 'height' && typeof message.height === 'number') {
        // A page that measures itself as nothing is a page mid-layout, not a
        // page of zero height — collapsing the frame there makes it vanish.
        if (message.height > 0) {
          setHeight(message.height);
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [postTheme]);

  useEffect(() => {
    postTheme();
  }, [appearance, postTheme]);

  if (urlFor === null) {
    return (
      <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        This artifact cannot be opened here.
      </p>
    );
  }

  return (
    <iframe
      ref={frame}
      // Keyed by the exact version so a republish loads the new page rather
      // than leaving React to reuse the element with a stale document.
      key={`${artifact.artifactId}:${artifact.version}`}
      src={urlFor(artifact)}
      title={artifact.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={postTheme}
      className={cn(
        'w-full rounded-lg border border-border bg-transparent',
        className,
      )}
      style={fill ? undefined : { height: Math.min(height, MAX_INLINE_HEIGHT) }}
    />
  );
}
