import type { LabelInstructionWire } from '../tasks.types';

/**
 * One label-instruction row as `LabelInstructionsService.forTask` answers it.
 *
 * Annotated rather than cast, so a field the wire gains cannot go missing here
 * and still compile.
 */
export const aLabelInstruction = (
  over: Partial<LabelInstructionWire> = {},
): LabelInstructionWire => ({
  id: 'li-1',
  projectId: null,
  label: 'bug',
  instructions: 'Write a regression test.',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  ...over,
});
