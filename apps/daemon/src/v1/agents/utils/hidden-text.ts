/**
 * Text that would show the user something other than what it holds — the one
 * rule for every short text an agent writes onto a card (an action's label and
 * message, a team proposal's summary): any
 * control, any format character (bidi overrides, isolates and marks,
 * zero-width characters, invisible tags), anything Unicode says to draw as
 * nothing, and the line and paragraph separators. Emoji stay usable, and only
 * by position: a joiner between two pictographs (a skin tone or a
 * presentation selector may sit before it), and one presentation selector
 * straight after an emoji. Every other variation selector is refused — they
 * draw as nothing, so a run of them could carry text nobody sees.
 */
const HIDDEN_TEXT =
  /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u;
const EMOJI_JOINER =
  /(?<=\p{Extended_Pictographic}[\p{Emoji_Modifier}\uFE0F]?)\u200D(?=\p{Extended_Pictographic})/gu;
const EMOJI_PRESENTATION = /(?<=\p{Emoji}\p{Emoji_Modifier}?)[\uFE0E\uFE0F]/gu;

/** `lineBreaks`: a message may hold tabs and newlines; a label is one line. */
export function hasHiddenText(value: string, lineBreaks: boolean): boolean {
  const visible = value
    .replace(EMOJI_JOINER, '')
    .replace(EMOJI_PRESENTATION, '');
  return HIDDEN_TEXT.test(
    lineBreaks ? visible.replace(/[\t\n\r]/g, '') : visible,
  );
}
