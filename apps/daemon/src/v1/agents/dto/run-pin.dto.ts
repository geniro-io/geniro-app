import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const setRunPinnedSchema = z.object({
  /**
   * The state the run should END in, never a toggle.
   *
   * A toggle answers a different question every time it is replayed — a
   * retried request, two windows pressing at once — and the two clients would
   * then disagree about whether the thread is pinned while both believe they
   * asked for the same thing.
   */
  pinned: z.boolean(),
});
export class SetRunPinnedDto extends createZodDto(setRunPinnedSchema) {}

export const reorderPinnedSchema = z.object({
  /**
   * The scope whose band this arrangement is for — a group, or null for the
   * loose list.
   *
   * Stated rather than derived from the ids, and that is what bounds the
   * write: `pinnedPosition` is contiguous WITHIN a scope, so a list that
   * happened to name runs from two groups would otherwise renumber both from
   * one sequence and interleave two bands. Every id outside this scope is
   * ignored.
   */
  groupId: z.string().min(1).nullable(),
  /**
   * The band's whole ORDER, not a displacement.
   *
   * The sidebar reorders by dragging, where the gesture produces an
   * arrangement rather than a move — which also makes the write idempotent,
   * where a relative move replayed moves twice. `RunGroupsService.reorder`
   * takes the same shape for the same reason.
   */
  ids: z.array(z.string().min(1)),
});
export class ReorderPinnedDto extends createZodDto(reorderPinnedSchema) {}
