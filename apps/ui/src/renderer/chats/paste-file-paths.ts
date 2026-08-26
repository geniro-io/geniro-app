/**
 * A pasted FILE is its PATH, not its name.
 *
 * macOS writes a copied file to the pasteboard as a file URL plus a plain-text
 * flavour holding the file's NAME, and Chromium's default paste inserts that
 * text — so copying a file in Finder and pasting it into the composer typed
 * `CLAUDE.md`, which names nothing the agent can open. Reported as "должен
 * вставляться его полный путь… хотя вставляется только название файла".
 */

/** Resolves a file the OS handed the renderer to its absolute path. */
export type FilePathResolver = (file: File) => string | null;

const preloadResolver: FilePathResolver = (file) =>
  window.geniro.filePath(file);

/**
 * The absolute paths of the files a paste carried, in clipboard order.
 *
 * Images are left out: those are staged as attachments and travel as bytes, so
 * a path would name a file the agent has no reason to open. A file with no
 * path on disk is left out too — `GeniroApi.filePath` answers those with null.
 */
export function filePathsFromClipboard(
  data: DataTransfer | null,
  resolve: FilePathResolver,
): string[] {
  return [...(data?.files ?? [])]
    .filter((file) => !file.type.startsWith('image/'))
    .map(resolve)
    .filter((path): path is string => path !== null && path.length > 0);
}

/**
 * Write the paths of any pasted files into the focused field. Returns whether
 * anything was written, which is what tells the caller to swallow the paste.
 *
 * `execCommand` rather than a state update: it inserts at the caret, keeps the
 * field's own undo stack, and fires the `input` event a controlled value is
 * written from. A field that cannot take the insertion keeps its default
 * paste — the bare name is a poor answer, but losing the paste is a worse one.
 */
export function insertPastedFilePaths(
  data: DataTransfer | null,
  resolve: FilePathResolver = preloadResolver,
): boolean {
  const paths = filePathsFromClipboard(data, resolve);
  return (
    paths.length > 0 &&
    document.execCommand('insertText', false, paths.join(' '))
  );
}
