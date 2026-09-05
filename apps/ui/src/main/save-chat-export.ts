import { writeFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { dialog, type FileFilter } from 'electron';

import type { ChatExportSaveResult } from '../shared/contracts';

/**
 * The two shapes a conversation can be saved as, in the order the panel offers
 * them — so the FIRST entry is both the default filter and the extension the
 * suggested name gets.
 *
 * Markdown leads because it is what a person opens: a bug report, a review, a
 * note to a colleague. The JSON is the complete record — every column, every
 * payload, nothing interpreted — which is what a machine or a maintainer wants
 * and is one row down in the same dropdown.
 */
const EXPORT_FORMATS: FileFilter[] = [
  { name: 'Markdown', extensions: ['md'] },
  { name: 'Geniro chat export (JSON)', extensions: ['json'] },
];

/**
 * Ask the user where to keep a chat export, and write it there.
 *
 * ONE channel doing both halves, unlike the workflow export beside it
 * (`pickWorkflowExport` → the DAEMON writes the path it was handed). The
 * difference is who holds the bytes: a workflow lives in the daemon's library,
 * so the renderer has only a slug to pass along, while a chat export is a
 * document the renderer already fetched and holds in full. Handing that path
 * back down for a second process to re-derive the same document would be a
 * second read of a long transcript, and a window in which the two could differ.
 *
 * BOTH renderings are passed and one is written, which is the shape the format
 * choice forces. The user picks the format in an AppKit save panel, so main is
 * the only side that can know which — and the alternatives are worse: a
 * pick-then-write pair would need a channel that writes to a path the RENDERER
 * names, and main serializing for itself would put the renderer's own document
 * formatting in the main bundle.
 *
 * What it costs, stated rather than waved away: the renderer builds both
 * documents up front and one is always discarded — including on a cancel, which
 * is the commonest outcome below. On a long transcript that is two full-size
 * strings and an IPC copy of each. The trade is deliberate; the price is not
 * zero.
 *
 * A CANCEL is not a failure — `saved: false` with no path, and the caller says
 * nothing. It is the commonest outcome of opening a save dialog.
 */
export async function saveChatExport(input: {
  suggestedName: string;
  json: string;
  markdown: string;
}): Promise<ChatExportSaveResult> {
  const result = await dialog.showSaveDialog({
    // The extension is appended HERE rather than by the caller, so the name the
    // panel opens with and the filter it opens on cannot disagree — see
    // `chatExportBaseName`.
    defaultPath: `${input.suggestedName}.${EXPORT_FORMATS[0]!.extensions[0]!}`,
    filters: EXPORT_FORMATS,
  });
  if (result.canceled || !result.filePath) {
    return { saved: false, path: null };
  }
  // Decided from the PATH rather than from which filter was selected, because
  // that is what the user actually chose: the panel lets them type any name they
  // like, and a `.json` typed under the Markdown filter means JSON. Anything
  // else falls back to markdown, which is the default the panel opened on.
  const wantsJson = extname(result.filePath).toLowerCase() === '.json';
  await writeFile(
    result.filePath,
    wantsJson ? input.json : input.markdown,
    'utf8',
  );
  return { saved: true, path: result.filePath };
}
