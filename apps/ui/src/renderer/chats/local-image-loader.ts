import { createContext } from 'react';

/** Reads one local image the agent referenced back as a `data:` URL. */
export type LocalImageLoader = (path: string) => Promise<string>;

/**
 * How a picture named by a PATH reaches the screen.
 *
 * A context rather than a prop for the reason `AttachmentLoaderContext` is one:
 * every shell between `Chats` and a transcript row is memoized, and threading a
 * loader through each would defeat that. The RUN is bound by the provider
 * rather than passed per call — the consumers render one run's transcript and
 * have no run id of their own, and giving them one would mean a new prop on
 * every call site for a value only this needs.
 *
 * It lives in its own module rather than in `markdown-image.tsx`, where it
 * started, because it has a second consumer now: the gallery card resolves its
 * tiles through the same loader over the same daemon route, so this is "how any
 * local picture reaches the screen" rather than a markdown detail.
 *
 * Null outside a provider: a consumer then says so rather than throwing or
 * showing a broken box.
 */
export const LocalImageLoaderContext = createContext<LocalImageLoader | null>(
  null,
);

/**
 * Schemes the renderer will not fetch, and why, in the user's own words.
 *
 * Beside the context rather than in either consumer, because it is the POLICY
 * on what that loader may be asked for — every surface resolving a local
 * picture owes its reader the same first door, and the daemon's own scheme
 * check documents itself as "the second door" on the premise that the renderer
 * refuses these before asking. One copy, so two surfaces cannot come to
 * disagree about which schemes are refused or what a reader is told about them.
 */
export function refusalFor(src: string): string | null {
  if (src.startsWith('data:')) {
    return null; // inline bytes — the CSP already allows these
  }
  if (/^https?:/i.test(src)) {
    // Not a limitation to route around: this app makes no outbound requests,
    // and an agent-authored `![](https://…/?q=secrets)` is exactly the beacon
    // the renderer's `img-src 'self' data:` exists to stop. Said out loud
    // rather than shown as a broken image.
    return 'remote images are not loaded';
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) {
    return 'this image link is not a file on your machine';
  }
  return null;
}
