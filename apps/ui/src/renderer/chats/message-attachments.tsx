import { createContext, useContext, useEffect, useState } from 'react';

import { ZoomableImage } from '../components/ui/image-viewer';
import type { MessageAttachment } from './attachment-payload';

/** Reads one attachment's base64 bytes back from the daemon. */
export type AttachmentLoader = (
  runId: string,
  attachmentId: string,
) => Promise<string>;

/**
 * How a transcript row reaches the daemon for image bytes.
 *
 * A context rather than a prop: the row shells between `Chats` and a message
 * bubble (`TranscriptEntryView`, `TurnBlock`, `CallBlock`) are all memoized on
 * referentially stable props, and threading a loader through every one of them
 * would both bloat their signatures and defeat that memoization. Null outside a
 * provider — a bubble then renders its images as unavailable rather than
 * throwing.
 */
export const AttachmentLoaderContext = createContext<AttachmentLoader | null>(
  null,
);

/**
 * Fetches one attachment's bytes and yields a `data:` URL.
 *
 * The bytes come over the token-gated daemon route rather than a plain `src`
 * URL, because an `<img>` cannot send an Authorization header and every daemon
 * route but `/health` demands one. The result is a data URL, so there is no
 * object-URL lifetime to manage when the row unmounts mid-flight.
 */
export function useAttachmentSource(
  runId: string,
  attachment: MessageAttachment,
  load: AttachmentLoader | null,
): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!load) {
      return;
    }
    let live = true;
    setFailed(false);
    void load(runId, attachment.id)
      .then((data) => {
        if (live) {
          setSrc(`data:${attachment.mediaType};base64,${data}`);
        }
      })
      .catch(() => {
        if (live) {
          setFailed(true);
        }
      });
    return () => {
      live = false;
    };
  }, [runId, attachment.id, attachment.mediaType, load]);

  return { src, failed };
}

function Thumbnail({
  runId,
  attachment,
}: {
  runId: string;
  attachment: MessageAttachment;
}): React.JSX.Element {
  const load = useContext(AttachmentLoaderContext);
  const { src, failed } = useAttachmentSource(runId, attachment, load);
  if (failed || !load) {
    return (
      <span className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
        image unavailable
      </span>
    );
  }
  return (
    <span
      data-slot="message-attachment"
      className="block size-32 overflow-hidden rounded-lg border border-border bg-muted">
      {src ? (
        // The thumbnail is an `object-cover` square, so a pasted screenshot —
        // the overwhelmingly common case — is cropped to its middle third and
        // the transcript holds the only copy of it. Pressing it is how the
        // whole picture is seen; nothing else in the app can show it.
        <ZoomableImage
          src={src}
          alt="Attached image"
          title="Attached image"
          className="block size-full"
          imgClassName="size-full object-cover"
        />
      ) : null}
    </span>
  );
}

/** The image row inside a user message bubble. */
export function MessageAttachments({
  runId,
  attachments,
}: {
  runId: string;
  attachments: MessageAttachment[];
}): React.JSX.Element | null {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <Thumbnail key={attachment.id} runId={runId} attachment={attachment} />
      ))}
    </div>
  );
}
