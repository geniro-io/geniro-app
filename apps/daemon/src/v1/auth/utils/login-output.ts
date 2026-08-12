/**
 * The sign-in link a CLI printed, out of whatever else it wrote.
 *
 * CLI-AGNOSTIC on purpose, and this is not a per-CLI fact dodging the adapter
 * rule: what differs between the two CLIs is the sentence around the link
 * ("If the browser didn't open, visit: …" vs "Open a browser and navigate to
 * this link: …"), and matching sentences is exactly what would break on a
 * re-wording. The link itself is the stable part — an `https://` token — so the
 * shape being matched is a URL, not a CLI.
 *
 * Takes the FIRST link, because both CLIs print the authorization URL before
 * anything else and a later one would be documentation. Returns null when there
 * is none yet, which is the normal state for the first few hundred milliseconds.
 */
export function firstUrlIn(output: string): string | null {
  // Stops at whitespace and at the characters a CLI puts AFTER a URL in prose —
  // a trailing `)`, `>`, quote or comma. A bare `.` is deliberately allowed
  // through the character class and trimmed below instead, because a sentence
  // ending in a full stop is indistinguishable from a path segment until the end.
  const match = /https?:\/\/[^\s<>"')]+/.exec(output);
  if (!match) {
    return null;
  }
  return match[0].replace(/[.,;:]+$/, '');
}

/**
 * The CLI's own last meaningful line, for showing the user what is happening.
 *
 * Deliberately NOT the whole output. A sign-in's stdout is the one stream in
 * this app that can carry a one-time code or a token, and the debug log — which
 * every entry passes through a redactor — cannot protect a string this module
 * hands to the renderer instead. One short line, and never the URL line (the URL
 * has its own field, and repeating it here would put a live challenge into a
 * label that gets copied into bug reports).
 */
export function lastProgressLine(output: string): string | null {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    // A CLI writing a prompt with no newline leaves it as the last "line"; that
    // is still the most informative thing it has said, so prompts stay.
    .filter((line) => line.length > 0 && !/https?:\/\//.test(line));
  return lines.length > 0 ? (lines[lines.length - 1] ?? null) : null;
}
