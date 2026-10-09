/**
 * The URL schemes a link may open in the reader's browser. Anything else (`file:`,
 * custom app schemes) is refused: `shell.openExternal` on untrusted input can be
 * coerced into running arbitrary commands (Electron security checklist #14).
 *
 * Shared by the two halves that decide it: the artifact frame, which offers a link a
 * page posted to the reader (renderer), and the window-open handler, which hands the
 * URL to the system browser (main). They must admit the same schemes, or a link one
 * side offers is refused by the other with no message at all.
 */
export const EXTERNAL_LINK_SCHEMES: ReadonlySet<string> = new Set([
  'https:',
  'http:',
  'mailto:',
]);
