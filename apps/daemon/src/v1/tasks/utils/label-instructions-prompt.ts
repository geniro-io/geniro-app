import { MAX_CUSTOM_INSTRUCTIONS_CHARS } from '../../agents/chat.types';
import { capWholeSections } from '../../agents/utils/cap-whole-sections';
import type {
  ComposedLabelInstructions,
  LabelInstructionWire,
} from '../tasks.types';

const LABEL_BLOCK_HEADER = "Instructions attached to this task's labels:";
const LABEL_BLOCK_SEPARATOR = '\n\n';

/**
 * One block for the turn's composed instructions, or a null `text` when the
 * task's labels attach nothing.
 *
 * `rows` is already in the order the caller wants read (see
 * `LabelInstructionsService.forTask`); this only formats and caps it.
 *
 * Bounded against {@link MAX_CUSTOM_INSTRUCTIONS_CHARS} — the budget for the
 * LABEL SECTIONS alone, never the user's own instructions or the report ask,
 * which are bounded independently at their own call sites. A card may carry
 * up to 20 labels each matching a global and a project row of up to 16,000
 * characters, which uncapped could exceed `ARG_MAX` in a spawned CLI's argv.
 *
 * A section that would overflow is left out WHOLE rather than cut
 * mid-sentence, and the walk continues, so a later short section still gets
 * in after an earlier one was skipped. When anything was left out, `text`
 * carries a trailing note naming it, so the omission reaches the agent and
 * not only the caller's own log — `text` is null only when there is nothing
 * to say at all (no rows). The note itself sits outside the bound; naming at
 * most 40 labels, it adds a couple of thousand characters at worst.
 */
export function composeLabelInstructions(
  rows: readonly LabelInstructionWire[],
): ComposedLabelInstructions {
  if (rows.length === 0) {
    return { text: null, omitted: [] };
  }
  const budget =
    MAX_CUSTOM_INSTRUCTIONS_CHARS -
    (LABEL_BLOCK_HEADER.length + LABEL_BLOCK_SEPARATOR.length);
  const { kept, omitted } = capWholeSections(
    rows,
    sectionOf,
    LABEL_BLOCK_SEPARATOR,
    budget,
  );
  // Named with the section's own scope marker, so a label whose global row
  // fit and whose project row did not is told apart in the note and the log.
  const omittedNames = omitted.map(scopedName);
  const body =
    kept.length === 0
      ? ''
      : `${LABEL_BLOCK_SEPARATOR}${kept.map(sectionOf).join(LABEL_BLOCK_SEPARATOR)}`;
  const note =
    omittedNames.length === 0
      ? ''
      : `${LABEL_BLOCK_SEPARATOR}(Left out for length: ${omittedNames.join(', ')}.)`;
  return {
    text: `${LABEL_BLOCK_HEADER}${body}${note}`,
    omitted: omittedNames,
  };
}

/** A label with its scope marker — `bug`, or `bug (project)` for a project row. */
function scopedName(row: LabelInstructionWire): string {
  return `${row.label}${row.projectId === null ? '' : ' (project)'}`;
}

/**
 * The heading quotes the label ALONE and puts the scope marker after it
 * (`## Label "bug" (project)`), so the quoted text is exactly the label a user
 * attached; the note and `omitted` use {@link scopedName} instead.
 */
function sectionOf(row: LabelInstructionWire): string {
  return `## Label "${row.label}"${row.projectId === null ? '' : ' (project)'}\n${row.instructions}`;
}
