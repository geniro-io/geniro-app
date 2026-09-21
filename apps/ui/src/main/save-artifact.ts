import { writeFile } from 'node:fs/promises';

import { dialog, type FileFilter } from 'electron';

import type { FileSaveResult } from '../shared/contracts';

/**
 * ONE format, unlike the chat export's two.
 *
 * An artifact is a document the agent authored as HTML; there is no second
 * rendering of it to offer, and a panel whose dropdown holds one entry is
 * simply how a single-format save looks.
 */
const ARTIFACT_FORMATS: FileFilter[] = [
  { name: 'Web page (HTML)', extensions: ['html'] },
];

/**
 * Ask the user where to keep a published artifact, and write it there.
 *
 * The renderer holds the bytes, exactly as it does for a chat export — it
 * fetched the document from the daemon and baked the current theme into it —
 * so this is one channel doing both halves rather than a pick-then-write pair
 * (see `save-chat-export.ts`, which states that reasoning in full).
 *
 * What it does NOT do is gather anything up beside the file. An artifact page
 * is served under a CSP that allows no network and no external subresources,
 * so it is self-contained by construction: one file is the whole document, and
 * there is no bundle step that could be missing.
 *
 * The extension is appended HERE rather than by the caller, so the name the
 * panel opens with and the filter it opens on cannot disagree. Unlike the chat
 * export, nothing is decided from the path afterwards: with one format there
 * is no second document to choose between, so a user who types `.txt` gets
 * their bytes under the name they asked for.
 *
 * A CANCEL is not a failure — `saved: false` with no path, and the caller says
 * nothing. It is the commonest outcome of opening a save dialog.
 */
export async function saveArtifact(input: {
  suggestedName: string;
  html: string;
}): Promise<FileSaveResult> {
  const result = await dialog.showSaveDialog({
    defaultPath: `${input.suggestedName}.${ARTIFACT_FORMATS[0]!.extensions[0]!}`,
    filters: ARTIFACT_FORMATS,
  });
  if (result.canceled || !result.filePath) {
    return { saved: false, path: null };
  }
  await writeFile(result.filePath, input.html, 'utf8');
  return { saved: true, path: result.filePath };
}
