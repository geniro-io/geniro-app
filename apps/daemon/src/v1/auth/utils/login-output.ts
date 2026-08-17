/**
 * A pty child's output as plain text: escape sequences gone, CR line endings
 * normalized.
 *
 * A sign-in the daemon runs under a terminal (`AgentCommandOptions.pty`) writes
 * TERMINAL output, and the readers below are written for prose. The one that
 * breaks without this is {@link firstUrlIn}: claude emits its authorization URL
 * as an OSC-8 hyperlink — `ESC ] 8 ; ; <url> BEL <url> ESC ] 8 ; ; BEL` — and
 * BEL is neither whitespace nor one of the characters that regex stops at, so
 * the match would run straight through it and hand the browser one URL glued to
 * a copy of itself. Measured on 2.1.232.
 *
 * Applied unconditionally: output that carries no escapes is returned
 * unchanged, so there is no second path to keep in step.
 */
export function plainTerminalText(raw: string): string {
  // The one place in this codebase where matching control characters IS the
  // job: the rule exists to catch a control byte that reached a pattern by
  // accident, and every one below is named on purpose, in escaped form, with
  // the sequence it strips written out beside it.
  /* eslint-disable no-control-regex */
  return (
    raw
      // OSC — `ESC ] … BEL` or `ESC ] … ESC \`, PAYLOAD INCLUDED.
      //
      // Dropping the payload is what makes an OSC-8 hyperlink read correctly,
      // and keeping it was measured to be wrong: the sequence is
      // `ESC ] 8 ; ; <url> BEL <url> ESC ] 8 ; ; BEL` — the target inside the
      // escape and the visible text after it are the SAME url — so preserving
      // the escape's copy handed the caller one url glued to a second copy of
      // itself. Observed end-to-end before this was narrowed: a live
      // `mcp-login` answered with exactly that doubled string.
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      // CSI — cursor moves, colours, erases. Nothing here carries meaning
      // to a reader of prose.
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // Whatever single-character escapes and bells are left over — and then
      // every remaining C0 control byte, newline and tab excepted.
      //
      // The second rule is not belt-and-braces over the first. A pty echoes the
      // wrapper's own housekeeping as literal control BYTES — the measured
      // output opens `EOT BS BS` before the CLI's first word — and those are
      // not escape sequences, so nothing above touches them. They reach the
      // wire through `message`, and a raw control character inside a JSON
      // string is invalid JSON: the route answered 200 with a body the client
      // could not parse, which is a harder failure to read than any of the ones
      // this function exists for.
      .replace(/[\u001b\u0007]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  );
  /* eslint-enable no-control-regex */
}

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
