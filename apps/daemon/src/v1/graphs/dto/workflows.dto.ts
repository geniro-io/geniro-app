import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  NodeStateWireSchema,
  WorkflowSchema,
  WorkflowSummarySchema,
  WorkflowWireSchema,
} from '../graphs.types';

/**
 * HTTP DTOs for the workflow-library routes. Inputs are validated by the global
 * `ZodValidationPipe`; outputs are declared with `@ZodResponse`. The workflow
 * body reuses the domain `WorkflowSchema` — the same shape the YAML files hold,
 * and the same shape the read routes return, so the generated client carries a
 * single `Workflow` type the builder can round-trip. Import/export paths are
 * absolute file paths the user picked in a native dialog (loopback +
 * token-gated surface).
 */
export const createWorkflowSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-_]*$/)
    .optional(),
  workflow: WorkflowSchema,
});
export class CreateWorkflowDto extends createZodDto(createWorkflowSchema) {}

export const saveWorkflowSchema = z.object({
  workflow: WorkflowSchema,
});
export class SaveWorkflowDto extends createZodDto(saveWorkflowSchema) {}

export const importWorkflowSchema = z.object({
  path: z.string().min(1),
});
export class ImportWorkflowDto extends createZodDto(importWorkflowSchema) {}

export const exportWorkflowSchema = z.object({
  path: z.string().min(1),
});
export class ExportWorkflowDto extends createZodDto(exportWorkflowSchema) {}

export const runWorkflowSchema = z.object({
  /** Shared working folder every node runs in (validated server-side). */
  cwd: z.string().min(1),
  /** The user's task — seeds every node's prompt. */
  prompt: z.string().min(1),
});
export class RunWorkflowDto extends createZodDto(runWorkflowSchema) {}

// ── Responses ───────────────────────────────────────────────────────────────

/** One workflow definition addressed by its library slug. */
export class WorkflowFileDto extends createZodDto(WorkflowWireSchema) {}

/** A workflow as listed from the library (counts, no full definition). */
export class WorkflowSummaryDto extends createZodDto(WorkflowSummarySchema) {}

/** Per-node execution state of one workflow run. */
export class NodeStateDto extends createZodDto(NodeStateWireSchema) {}

/** Acknowledgement of a library delete. */
export class DeletedDto extends createZodDto(
  z.object({ deleted: z.boolean() }),
) {}

/** Acknowledgement of an export to a user-chosen path. */
export class ExportedDto extends createZodDto(
  z.object({ exported: z.boolean() }),
) {}
