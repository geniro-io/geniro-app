import { createContext, useContext, useEffect, useState } from 'react';

/** Reads one agent-referenced local image back as a `data:` URL. */
export type MarkdownImageLoader = (path: string) => Promise<string>;

/**
 * How a markdown image in an agent's message reaches its bytes.
 *
 * A context for the reason {@link AttachmentLoaderContext} is one: every shell
 * between `Chats` and a message bubble is memoized, and threading a loader
 * through each would defeat that. The RUN is bound by the provider rather than
 * passed per call — `MarkdownContent` renders one run's transcript and has no
 * run id of its own, and giving it one would mean a new prop on all four of its
 * call sites for a value only this needs.
 *
 * Null outside a provider: an image then renders as its own reference rather
 * than throwing or showing a broken box.
 */
export const MarkdownImageLoaderContext =
  createContext<MarkdownImageLoader | null>(null);

/** Schemes the renderer will not fetch, and why, in the user's own words. */
function refusalFor(src: string): string | null {
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

/**
 * One image an agent referenced from its own markdown.
 *
 * The reported defect was "i dont see images", and the reason was two
 * independent walls. The renderer's CSP is `img-src 'self' data:`, so a
 * `file:` source is refused outright; and a bare relative reference —
 * `![](a.png)`, one of the two forms measured in the author's own history —
 * resolves against the app's own origin, which has nothing to do with the
 * folder the agent was working in. Both are answered the same way the pasted
 * attachments already are: fetch the bytes over the token-gated daemon route
 * and hand the tag a `data:` URL.
 *
 * A failure shows the REFERENCE, not a broken-image box. "geniro could not read
 * /tmp/shots/x.png" is a fact the user can act on; a grey placeholder is the
 * bug being reported again.
 */
export function MarkdownImage({
  src,
  alt,
}: {
  src?: string | Blob;
  alt?: string;
}): React.JSX.Element {
  const load = useContext(MarkdownImageLoaderContext);
  // `src` is typed loosely by the markdown renderer's HTML props; only a string
  // is a reference we can do anything with.
  const reference = typeof src === 'string' ? src.trim() : '';
  const refusal = reference === '' ? 'no image source' : refusalFor(reference);
  const inline = reference.startsWith('data:');
  const [resolved, setResolved] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!load || refusal !== null || inline || reference === '') {
      return;
    }
    let live = true;
    setFailed(null);
    void load(reference)
      .then((url) => {
        if (live) {
          setResolved(url);
        }
      })
      .catch((err: unknown) => {
        if (live) {
          setFailed(err instanceof Error ? err.message : 'could not be read');
        }
      });
    return () => {
      live = false;
    };
  }, [load, reference, refusal, inline]);

  if (refusal !== null) {
    return (
      <span
        data-slot="markdown-image-unavailable"
        className="my-1 inline-block rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
        {alt ? `${alt} — ` : ''}
        {refusal}
        {reference && !reference.startsWith('data:') ? ` (${reference})` : ''}
      </span>
    );
  }
  if (failed !== null) {
    return (
      <span
        data-slot="markdown-image-unavailable"
        className="my-1 inline-block rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
        could not read {reference}
      </span>
    );
  }
  const url = inline ? reference : resolved;
  if (url === null) {
    // Nothing yet — a bare box would be indistinguishable from the failure
    // above, so the reference itself stands in until the bytes land.
    return (
      <span
        data-slot="markdown-image-loading"
        className="my-1 inline-block text-xs text-muted-foreground">
        {alt || reference}
      </span>
    );
  }
  return (
    <img
      data-slot="markdown-image"
      src={url}
      alt={alt ?? ''}
      className="my-1 max-h-96 max-w-full rounded-lg border border-border object-contain"
    />
  );
}
