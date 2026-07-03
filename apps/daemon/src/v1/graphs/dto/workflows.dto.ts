import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { WorkflowSchema } from '../graphs.types';

/**
 * HTTP input DTOs for the workflow-library routes, validated by the global
 * `ZodValidationPipe`. The workflow body reuses the domain `WorkflowSchema` —
 * the same shape the YAML files hold. Import/export paths are absolute file
 * paths the user picked in a native dialog (loopback + token-gated surface).
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
