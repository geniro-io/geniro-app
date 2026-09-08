import { useCallback, useState } from 'react';

import { insertPastedFilePaths } from '../chats/paste-file-paths';
import type { DaemonApis } from '../daemon-api';

/** What the daemon will store; anything else keeps the browser's own paste. */
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** The alt text a clipboard screenshot is referenced under. */
const PASTED_NAME = 'Pasted image';

/** Strip the `data:<type>;base64,` head a `FileReader` result carries. */
function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? '' : dataUrl.slice(comma + 1);
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('could not read the pasted image'));
    };
    reader.onload = () => {
      resolve(base64Of(String(reader.result ?? '')));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Paste a screenshot or a file into a task's description and have it LAND.
 *
 * REPORTED as "я всё ещё не могу вставлять файлы или изображения. Например,
 * когда я делаю скриншот и нажимаю «Вставить», он должен автоматически
 * добавлять файл с description в Markdown. Сейчас ничего не происходит" — and
 * nothing was happening because nothing was listening: the composer has had
 * both halves of this for months and the description field had neither.
 *
 * Two kinds, and the split is the composer's own. An IMAGE is bytes with no
 * path, so it is written to disk by the daemon and referenced as
 * `![name](path)`. Anything ELSE the clipboard carries as a file already IS a
 * path, so `insertPastedFilePaths` writes that path verbatim — a `.pdf`, a
 * `.csv`, a source file — which is exactly what a description wants, since the
 * agent that reads it can open the thing.
 *
 * The reference is a PATH in both cases rather than an inline `data:` URL, and
 * that is the decision the rest follows from: a description is a brief an AGENT
 * works from, and an agent cannot read a base64 blob out of a prompt as a file.
 * See `TaskAttachmentService`.
 *
 * The insertion goes through `execCommand('insertText')` for
 * `insertPastedFilePaths`' three recorded reasons: it lands at the CARET, keeps
 * the field's own undo stack, and fires the `input` event a controlled value is
 * written from. A state update would do none of the three.
 */
export function useDescriptionPaste({
  taskId,
  tasksApi,
}: {
  taskId: string;
  tasksApi: DaemonApis['tasks'] | null;
}): {
  /** Attach to the textarea. Returns whether it swallowed the paste. */
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** An upload that failed, in the daemon's own words — null when all is well. */
  error: string | null;
  /** True while bytes are on their way to disk. */
  uploading: boolean;
  dismissError: () => void;
} {
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
      const data = event.clipboardData;
      const image = [...(data?.files ?? [])].find((file) =>
        IMAGE_TYPES.has(file.type),
      );
      if (image === undefined) {
        // Not an image: any other pasted file becomes its own absolute path,
        // and a paste carrying no file at all falls through to the browser.
        if (insertPastedFilePaths(data)) {
          event.preventDefault();
        }
        return;
      }
      if (tasksApi === null) {
        return;
      }
      // Swallowed BEFORE the await: the default paste of an image file inserts
      // its NAME, and letting that land first would leave the word `Screenshot
      // 2026-09-08.png` in the description beside the reference we then add.
      event.preventDefault();
      setError(null);
      setUploading(true);
      void readAsBase64(image)
        .then((data64) =>
          tasksApi.addTaskAttachment({
            taskId,
            addTaskAttachmentDto: {
              mediaType: image.type as 'image/png',
              data: data64,
              ...(image.name === '' ? {} : { name: image.name }),
            },
          }),
        )
        .then((saved) => {
          // The FIELD may have lost focus while the bytes were in flight, and
          // `insertText` writes wherever the caret is — so a failed insertion
          // is reported rather than dropped, since the file is already on disk
          // and the user has no other way to reference it.
          const written = document.execCommand(
            'insertText',
            false,
            `![${saved.name || PASTED_NAME}](${saved.path})`,
          );
          if (!written) {
            setError(
              `The image was saved to ${saved.path}, but could not be written into the description — click into it and paste again.`,
            );
          }
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          setUploading(false);
        });
    },
    [taskId, tasksApi],
  );

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  return { onPaste, error, uploading, dismissError };
}
