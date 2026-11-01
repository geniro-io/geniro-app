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
  RunTeamSnapshotWireSchema,
  StageMoveRequestSchema,
  StageMoveResultSchema,
  StartTeamChatSchema,
  TeamChatsDiscardedSchema,
  TeamSchema,
  TeamSummarySchema,
  TeamWireSchema,
} from '../teams.types';

/**
 * HTTP DTOs for the team-library routes. Inputs are validated by the global
 * `ZodValidationPipe`; outputs are declared with `@ZodResponse`. The team
 * body reuses the domain `TeamSchema` — the same shape the YAML files hold,
 * and the same shape the read routes return, so the generated client carries a
 * single `Team` type the builder can round-trip. Import/export paths are
 * absolute file paths the user picked in a native dialog (loopback +
 * token-gated surface).
 */
export const createTeamSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-_]*$/)
    .optional(),
  team: TeamSchema,
});
export class CreateTeamDto extends createZodDto(createTeamSchema) {}

export const saveTeamSchema = z.object({
  team: TeamSchema,
  baseHash: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'The `hash` of the version this save was made from; a file changed since is refused 409 TEAM_CHANGED',
    ),
});
export class SaveTeamDto extends createZodDto(saveTeamSchema) {}

/**
 * The team as the team editor holds it — saved or not — plus the two
 * run settings the instruction block carries, which live in the Electron
 * process's `settings.json` and so are sent the way a run start sends them.
 */
export const measureInstructionSizesSchema = z.object({
  team: TeamSchema,
  customInstructions: CustomInstructionsSchema.optional(),
  replyLanguage: ReplyLanguageSchema.optional(),
});
export class MeasureInstructionSizesDto extends createZodDto(
  measureInstructionSizesSchema,
) {}

export class InstructionSizesDto extends createZodDto(
  InstructionSizesWireSchema,
) {}

export const importTeamSchema = z.object({
  path: z.string().min(1),
});
export class ImportTeamDto extends createZodDto(importTeamSchema) {}

export const exportTeamSchema = z.object({
  path: z.string().min(1),
});
export class ExportTeamDto extends createZodDto(exportTeamSchema) {}

export const runTeamSchema = z
  .object({
    /** Shared working folder every member runs in (validated server-side). */
    cwd: z.string().min(1),
    /**
     * The user's task — the trigger member's first message. May be empty when images
     * carry the message, exactly as a chat message may.
     */
    prompt: z.string(),
    /** Pasted images, delivered to the trigger member. */
    images: messageImagesSchema.optional(),
    /**
     * The app's global custom instructions, snapshotted onto the run exactly as
     * a chat snapshots them (`createChatSchema.customInstructions`).
     *
     * Sent by the client for the same reason: the value lives in the Electron
     * process's `settings.json`, which the daemon never opens. Every member
     * composes it BEHIND its own `instructions`, so a member authored for one
     * job still outranks a standing preference.
     */
    customInstructions: CustomInstructionsSchema.optional(),
    /** The user's reply language, snapshotted onto the run like a chat's. */
    replyLanguage: ReplyLanguageSchema.optional(),
    /**
     * The user's per-CLI switches, snapshotted onto the run exactly as a chat
     * snapshots them ({@link Run.agentOptions}); each member's turn carries
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
    'a team run needs a task or at least one image',
  );
export class RunTeamDto extends createZodDto(runTeamSchema) {}

/**
 * The composer settings the builder's chat panel opens its conversation with.
 * The schema is picked from the chat-create one, so every chip states the same
 * bound on both routes — see `StartTeamChatSchema`.
 */
export class StartTeamChatDto extends createZodDto(StartTeamChatSchema) {}

// ── Responses ───────────────────────────────────────────────────────────────

/** How many team-editing chats a discard destroyed. */
export class TeamChatsDiscardedDto extends createZodDto(
  TeamChatsDiscardedSchema,
) {}

/** One team definition addressed by its library slug. */
export class TeamFileDto extends createZodDto(TeamWireSchema) {}

/** The team ONE run runs — its own copy, not the library's current one. */
export class RunTeamSnapshotDto extends createZodDto(
  RunTeamSnapshotWireSchema,
) {}

/** A team as listed from the library (counts, no full definition). */
export class TeamSummaryDto extends createZodDto(TeamSummarySchema) {}

/** Per-member execution state of one team run. */
export class NodeStateDto extends createZodDto(NodeStateWireSchema) {}

/** The calls a cancelled usage-limit continue will no longer pick up. */
export class ResetWakesCancelledDto extends createZodDto(
  ResetWakesCancelledSchema,
) {}

/** Acknowledgement of a delete — a library team, or one run's history. */
export class TeamDeletedDto extends createZodDto(
  z.object({ deleted: z.boolean() }),
) {}

/** Acknowledgement of an export to a user-chosen path. */
export class ExportedDto extends createZodDto(
  z.object({ exported: z.boolean() }),
) {}

export class MoveTeamRunStageDto extends createZodDto(StageMoveRequestSchema) {}
export class StageMoveResultDto extends createZodDto(StageMoveResultSchema) {}
