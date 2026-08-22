/**
 * Free text reduced to one line short enough to be a label.
 *
 * Shared rather than spelled per caller because three surfaces reduce prose to
 * a label and must agree on what that produces: a skill's description in the
 * composer's autocomplete, the session picker's row for a conversation being
 * imported, and the title a chat falls back to when its CLI has none of its
 * own. Each carries its own budget, so the ceiling is the caller's; the
 * reduction is not.
 *
 * Control and format characters are dropped BEFORE the collapse, and that is a
 * guard rather than tidying. `\s` covers neither the C0 range nor the bidi
 * overrides, and one source of this text is agent-generated: a `U+202E` would
 * reach the sidebar able to spoof a row's label, and a NUL would reach a SQLite
 * TEXT column — which is what `CustomInstructionsSchema` already refuses on the
 * other untrusted-text path into this app.
 */
export function titleFromText(text: string, maxChars: number): string {
  const line = text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (line.length <= maxChars) {
    return line;
  }
  // Sliced by CODE POINT, not by `String.slice`'s UTF-16 units: an emoji
  // straddling the cut leaves a lone surrogate, which renders as `�` in the
  // very sidebar row this string exists for.
  const kept = [...line].slice(0, maxChars - 1).join('');
  return `${kept.trimEnd()}…`;
}
