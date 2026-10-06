import { useCallback, useRef, useState } from 'react';

/**
 * TWIN LIMIT: apps/daemon/src/v1/agents/chat.types.ts CHAT_UPLOAD_MAX_BYTES.
 *
 * The daemon enforces it; repeating it here refuses an oversize file BEFORE
 * its bytes have crossed the Wi-Fi only to be turned away.
 */
export const CHAT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * How long one upload may take. The daemon client's ordinary 30s budget is
 * for a request that carries a few bytes; a 25MB file over a phone's Wi-Fi —
 * or a tunnel — is a transfer, and failing it half way is worse than waiting.
 */
export const CHAT_UPLOAD_TIMEOUT_MS = 5 * 60_000;

/**
 * The message text with attached file paths added at its end, one per line.
 *
 * A line each rather than the space-joined run a paste inserts at the caret:
 * the button is pressed with no caret in the text, and the uploads directory
 * sits under `Application Support`, so a space-joined run of such paths is one
 * the agent cannot split back apart.
 */
export function appendPaths(text: string, paths: readonly string[]): string {
  if (paths.length === 0) {
    return text;
  }
  const joined = paths.join('\n');
  if (text.length === 0) {
    return joined;
  }
  return /\s$/.test(text) ? `${text}${joined}` : `${text}\n${joined}`;
}

/** What {@link useFileAttach} needs from the composer it serves. */
export interface FileAttachTarget {
  /** Whether this is a browser on another device, which has no paths here. */
  remote: boolean;
  /**
   * Stage what can travel as image bytes and answer with the rest —
   * `useAttachments().addFiles`.
   */
  stageImages: (files: readonly File[]) => File[];
  /** The file's absolute path on this Mac, or null — `GeniroApi.filePath`. */
  resolvePath: (file: File) => string | null;
  /** Store one file's bytes on the Mac and answer with its path there. */
  upload: (file: File) => Promise<string>;
  /** Whose draft is on screen now — a run id, or the landing composer's key. */
  currentOwner: () => string;
  /**
   * Add paths to a draft's text: the composer's own when `owner` is still on
   * screen, else that owner's parked draft. An upload is slow enough for the
   * user to switch threads while it runs, and a path landing in the thread on
   * screen would be sent from the wrong conversation.
   */
  deliver: (owner: string, paths: readonly string[]) => void;
}

/**
 * The composer's paperclip: route each picked file to the one place it can go.
 *
 * - An image the model accepts is STAGED as bytes, exactly as a pasted
 *   screenshot is, so the agent sees it rather than a path to it.
 * - Any other file on the Mac becomes its PATH in the message — the rule a
 *   pasted file already follows (`paste-file-paths.ts`): the file is here, the
 *   agent can open it, and a copy would go stale.
 * - On a phone there is no path to offer, so the file is UPLOADED to the Mac
 *   and the path of that copy goes into the message instead.
 *
 * `uploading` answers for the draft on screen, the rule `useAttachments`'
 * `reading` follows: Send waits for it, or a message pressed straight after a
 * pick would leave without the path it was written around.
 */
export function useFileAttach(target: FileAttachTarget): {
  attach: (files: readonly File[]) => void;
  uploading: boolean;
  error: string | null;
  clearError: () => void;
} {
  const [pending, setPending] = useState<
    readonly { id: number; owner: string }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const nextIdRef = useRef(0);
  // A ref, so `attach` keeps one identity while the caller hands a fresh
  // target object every render.
  const targetRef = useRef(target);
  targetRef.current = target;

  const attach = useCallback((files: readonly File[]): void => {
    const current = targetRef.current;
    setError(null);
    const rest = current.stageImages(files);
    if (rest.length === 0) {
      return;
    }
    // Whose draft these were picked for, captured NOW: an upload can outlive
    // the switch to another thread.
    const owner = current.currentOwner();
    if (!current.remote) {
      const paths = rest
        .map((file) => current.resolvePath(file))
        .filter((path): path is string => path !== null && path.length > 0);
      if (paths.length < rest.length) {
        setError('some of those files have no path on this Mac');
      }
      current.deliver(owner, paths);
      return;
    }
    const sendable = rest.filter((file) => {
      if (file.size > CHAT_UPLOAD_MAX_BYTES) {
        setError(
          `${file.name} is larger than ${Math.floor(CHAT_UPLOAD_MAX_BYTES / 1024 / 1024)}MB`,
        );
        return false;
      }
      return true;
    });
    if (sendable.length === 0) {
      return;
    }
    const id = nextIdRef.current++;
    setPending((list) => [...list, { id, owner }]);
    // One after another rather than all at once: each is a whole file's bytes
    // over the Wi-Fi, and in order so the paths land in the order picked.
    void (async () => {
      for (const file of sendable) {
        try {
          const path = await targetRef.current.upload(file);
          targetRef.current.deliver(owner, [path]);
        } catch (err: unknown) {
          setError(
            `could not upload ${file.name}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    })().finally(() => {
      setPending((list) => list.filter((entry) => entry.id !== id));
    });
  }, []);

  const clearError = useCallback((): void => setError(null), []);

  const onScreen = target.currentOwner();
  const uploading = pending.some((entry) => entry.owner === onScreen);

  return { attach, uploading, error, clearError };
}
