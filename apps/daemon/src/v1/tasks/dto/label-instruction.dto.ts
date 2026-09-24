import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  CustomInstructionsSchema,
  hasControlCharacters,
} from '../../agents/chat.types';
import { LabelInstructionWireSchema, TASK_LABEL_MAX } from '../tasks.types';

/**
 * HTTP DTOs for label-attached instructions.
 *
 * Inputs go through the global Zod pipe, outputs are declared with
 * `@ZodResponse` so the handler's return value is type-checked and the schema
 * reaches the OpenAPI document the renderer's client is generated from.
 */

/**
 * A label — non-blank after trimming, `Task.labels`' own bound, and free of
 * control characters and line breaks.
 *
 * A label with instructions attached is written into a composed task-run
 * instruction that reaches claude's argv
 * (`TaskRunsService.composeTaskInstructions`), where a NUL makes `spawn` throw on
 * every turn of that thread — so it is held to `hasControlCharacters`, the
 * same refusal `CustomInstructionsSchema` enforces. That check deliberately
 * admits tab, newline and carriage return, which are ordinary in multi-line
 * prose; a label is one line rendered inline in a heading
 * (`## Label "<label>"`), so those three are refused here too.
 */
const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(TASK_LABEL_MAX)
  .refine(
    (value) => !hasControlCharacters(value),
    'must not contain control characters',
  )
  .refine(
    (value) => !/[\n\r\t]/.test(value),
    'must not contain a newline or tab',
  );

/**
 * The instruction text — `CustomInstructionsSchema`'s control-character
 * refusal, plus non-blank: an instruction that is only
 * whitespace attaches nothing and is never what a user meant to save.
 */
const labelInstructionsTextSchema = CustomInstructionsSchema.refine(
  (value) => value.trim().length > 0,
  'must not be blank',
);

export const listLabelInstructionsQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
});
export class ListLabelInstructionsQueryDto extends createZodDto(
  listLabelInstructionsQuerySchema,
) {}

export const createLabelInstructionSchema = z.object({
  label: labelSchema,
  /** Absent or null = global, applying to every project. */
  projectId: z.string().min(1).nullable().optional(),
  instructions: labelInstructionsTextSchema,
});
export class CreateLabelInstructionDto extends createZodDto(
  createLabelInstructionSchema,
) {}

export const updateLabelInstructionSchema = z
  .object({
    label: labelSchema.optional(),
    /** Explicit null moves the row to global; an omitted key leaves it alone. */
    projectId: z.string().min(1).nullable().optional(),
    instructions: labelInstructionsTextSchema.optional(),
  })
  .refine(
    (dto) =>
      dto.label !== undefined ||
      dto.projectId !== undefined ||
      dto.instructions !== undefined,
    'a label-instruction patch must change the label, the project scope or the instructions',
  );
export class UpdateLabelInstructionDto extends createZodDto(
  updateLabelInstructionSchema,
) {}

// ── Responses ───────────────────────────────────────────────────────────────

/** One label's attached instructions. */
export class LabelInstructionDto extends createZodDto(
  LabelInstructionWireSchema,
) {}

export class LabelInstructionDeletedDto extends createZodDto(
  z.object({ deleted: z.boolean() }),
) {}
