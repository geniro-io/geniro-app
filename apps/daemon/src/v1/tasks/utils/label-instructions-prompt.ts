import type { LabelInstructionWire } from '../tasks.types';

const LABEL_BLOCK_HEADER = "Instructions attached to this task's labels:";
const LABEL_BLOCK_SEPARATOR = '\n\n';

/**
 * One block for the turn's composed instructions, or null when the task's
 * labels attach nothing.
 *
 * `rows` is already in the order the caller wants read (see
 * `LabelInstructionsService.forTask`); this only formats it. Every row is sent
 * whole, whatever its length: instruction text carries no size limit.
 */
export function composeLabelInstructions(
  rows: readonly LabelInstructionWire[],
): string | null {
  if (rows.length === 0) {
    return null;
  }
  return [LABEL_BLOCK_HEADER, ...rows.map(sectionOf)].join(
    LABEL_BLOCK_SEPARATOR,
  );
}

/**
 * The heading quotes the label ALONE and puts the scope marker after it
 * (`## Label "bug" (project)`), so the quoted text is exactly the label a user
 * attached.
 */
function sectionOf(row: LabelInstructionWire): string {
  return `## Label "${row.label}"${row.projectId === null ? '' : ' (project)'}\n${row.instructions}`;
}
