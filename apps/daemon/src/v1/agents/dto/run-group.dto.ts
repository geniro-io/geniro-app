import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  RUN_GROUP_NAME_MAX,
  RunGroupColorSchema,
  RunGroupWireSchema,
} from '../chat.types';

/**
 * HTTP DTOs for the sidebar-group routes.
 *
 * Same contract as the chat DTOs beside them: inputs go through the global Zod
 * pipe, outputs are declared with `@ZodResponse` so the handler's return value
 * is type-checked and the schema reaches the OpenAPI document the renderer's
 * client is generated from. A response DTO's ROOT schema carries no
 * `.meta({ id })` — see `chat.dto.ts` for why.
 */

/** A group's name — non-blank after trimming, sanely bounded. */
const groupNameSchema = z.string().trim().min(1).max(RUN_GROUP_NAME_MAX);

export const createRunGroupSchema = z.object({
  name: groupNameSchema,
  /** Omitted = the next hue in the palette, by how many groups exist. */
  color: RunGroupColorSchema.optional(),
  /**
   * A project folder whose new chats file themselves here. Omitted = a group
   * the user fills by hand. Checked and canonicalized by the service — a rule
   * pointing at a folder that does not exist could never fire.
   */
  autoCwd: z.string().min(1).optional(),
  /**
   * A workflow whose runs land here automatically, by slug. Omitted = the
   * group claims no workflow. Unchecked against the library on purpose — see
   * the entity's own note.
   */
  autoWorkflowId: z.string().min(1).optional(),
});
export class CreateRunGroupDto extends createZodDto(createRunGroupSchema) {}

export const updateRunGroupSchema = z
  .object({
    name: groupNameSchema.optional(),
    color: RunGroupColorSchema.optional(),
    collapsed: z.boolean().optional(),
    /**
     * Explicit null clears the auto-filing rule — the one thing an omitted key
     * (= leave unchanged) cannot say, the same contract the chat settings
     * patch uses for `model` and `effort`.
     */
    autoCwd: z.string().min(1).nullable().optional(),
    /** Explicit null clears the workflow rule, exactly as `autoCwd` does. */
    autoWorkflowId: z.string().min(1).nullable().optional(),
  })
  .refine(
    (dto) =>
      dto.name !== undefined ||
      dto.color !== undefined ||
      dto.collapsed !== undefined ||
      dto.autoCwd !== undefined ||
      dto.autoWorkflowId !== undefined,
    'a group patch must change the name, the colour, the folded state, the auto-file folder or the auto-file workflow',
  );
export class UpdateRunGroupDto extends createZodDto(updateRunGroupSchema) {}

export const reorderRunGroupsSchema = z.object({
  /**
   * Every group id, in the order the sidebar is now showing them — the whole
   * arrangement a drag produced, not a displacement of one row.
   *
   * A group the client omits keeps its place at the end rather than being
   * dropped, and an id naming nothing is ignored; see `RunGroupsService.reorder`
   * for why a stale list must not cost a group its position.
   */
  ids: z.array(z.string().min(1)),
});
export class ReorderRunGroupsDto extends createZodDto(reorderRunGroupsSchema) {}

export const setRunGroupSchema = z.object({
  /** Null files the run loose, out of every group. */
  groupId: z.string().min(1).nullable(),
});
export class SetRunGroupDto extends createZodDto(setRunGroupSchema) {}

// ── Responses ───────────────────────────────────────────────────────────────

/** One sidebar group. */
export class RunGroupDto extends createZodDto(RunGroupWireSchema) {}

/**
 * Acknowledgement of a group delete. It reports how many runs were RELEASED
 * rather than how many were removed, because none are: the count is the
 * sidebar's answer to "where did those chats go".
 */
export class RunGroupDeletedDto extends createZodDto(
  z.object({
    deleted: z.boolean().describe('True when the group row was removed'),
    released: z
      .number()
      .int()
      .describe(
        'How many runs moved out of the group — they are kept, never deleted with it',
      ),
  }),
) {}
