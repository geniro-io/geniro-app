import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  AgentOptionsSchema,
  commitShaSchema,
  CustomInstructionsSchema,
  ReplyLanguageSchema,
} from '../../agents/chat.types';
import { messageImagesSchema } from '../../agents/dto/chat.dto';
import {
  InstructionSizesWireSchema,
  NodeStateWireSchema,
  ResetWakesCancelledSchema,
  RunWorkflowSnapshotWireSchema,
  StartWorkflowChatSchema,
  WorkflowChatsDiscardedSchema,
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
  baseHash: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'The `hash` of the version this save was made from; a file changed since is refused 409 WORKFLOW_CHANGED',
    ),
});
export class SaveWorkflowDto extends createZodDto(saveWorkflowSchema) {}

/**
 * The workflow as the builder's canvas holds it — saved or not — plus the two
 * run settings the instruction block carries, which live in the Electron
 * process's `settings.json` and so are sent the way a run start sends them.
 */
export const measureInstructionSizesSchema = z.object({
  workflow: WorkflowSchema,
  customInstructions: CustomInstructionsSchema.optional(),
  replyLanguage: ReplyLanguageSchema.optional(),
});
export class MeasureInstructionSizesDto extends createZodDto(
  measureInstructionSizesSchema,
) {}

export class InstructionSizesDto extends createZodDto(
  InstructionSizesWireSchema,
) {}

export const importWorkflowSchema = z.object({
  path: z.string().min(1),
});
export class ImportWorkflowDto extends createZodDto(importWorkflowSchema) {}

export const exportWorkflowSchema = z.object({
  path: z.string().min(1),
});
export class ExportWorkflowDto extends createZodDto(exportWorkflowSchema) {}

export const runWorkflowSchema = z
  .object({
    /** Shared working folder every node runs in (validated server-side). */
    cwd: z.string().min(1),
    /**
     * The user's task — seeds every node's prompt. May be empty when images
     * carry the message, exactly as a chat message may.
     */
    prompt: z.string(),
    /** Pasted images, delivered to the agents the trigger feeds. */
    images: messageImagesSchema.optional(),
    /**
     * The app's global custom instructions, snapshotted onto the run exactly as
     * a chat snapshots them (`createChatSchema.customInstructions`).
     *
     * Sent by the client for the same reason: the value lives in the Electron
     * process's `settings.json`, which the daemon never opens. Every agent node
     * composes it BEHIND its own `role`, so a node authored for one job still
     * outranks a standing preference.
     */
    customInstructions: CustomInstructionsSchema.optional(),
    /** The user's reply language, snapshotted onto the run like a chat's. */
    replyLanguage: ReplyLanguageSchema.optional(),
    /**
     * The user's per-CLI switches, snapshotted onto the run exactly as a chat
     * snapshots them ({@link Run.agentOptions}); each agent node's turn carries
     * its own CLI's slice.
     */
    agentOptions: AgentOptionsSchema.optional(),
    /**
     * The folder's commit and dirty flag when the run starts, read by the client as a
     * chat create reads them — what the folder's line totals are measured against.
     */
    startSha: commitShaSchema.optional(),
    startDirty: z.boolean().optional(),
  })
  .refine(
    (dto) => dto.prompt.trim().length > 0 || (dto.images?.length ?? 0) > 0,
    'a workflow run needs a task or at least one image',
  );
export class RunWorkflowDto extends createZodDto(runWorkflowSchema) {}

/**
 * The composer settings the builder's chat panel opens its conversation with.
 * The schema is picked from the chat-create one, so every chip states the same
 * bound on both routes — see `StartWorkflowChatSchema`.
 */
export class StartWorkflowChatDto extends createZodDto(
  StartWorkflowChatSchema,
) {}

// ── Responses ───────────────────────────────────────────────────────────────

/** How many workflow-editing chats a discard destroyed. */
export class WorkflowChatsDiscardedDto extends createZodDto(
  WorkflowChatsDiscardedSchema,
) {}

/** One workflow definition addressed by its library slug. */
export class WorkflowFileDto extends createZodDto(WorkflowWireSchema) {}

/** The workflow ONE run runs — its own copy, not the library's current one. */
export class RunWorkflowSnapshotDto extends createZodDto(
  RunWorkflowSnapshotWireSchema,
) {}

/** A workflow as listed from the library (counts, no full definition). */
export class WorkflowSummaryDto extends createZodDto(WorkflowSummarySchema) {}

/** Per-node execution state of one workflow run. */
export class NodeStateDto extends createZodDto(NodeStateWireSchema) {}

/** The calls a cancelled usage-limit continue will no longer pick up. */
export class ResetWakesCancelledDto extends createZodDto(
  ResetWakesCancelledSchema,
) {}

/** Acknowledgement of a delete — a library workflow, or one run's history. */
export class WorkflowDeletedDto extends createZodDto(
  z.object({ deleted: z.boolean() }),
) {}

/** Acknowledgement of an export to a user-chosen path. */
export class ExportedDto extends createZodDto(
  z.object({ exported: z.boolean() }),
) {}
