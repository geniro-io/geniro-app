import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AgentKindSchema } from '../../runs/runs.types';
import {
  AttachmentMediaTypeSchema,
  ChatApprovalModeSchema,
  ItemWireSchema,
  MAX_ATTACHMENTS_PER_MESSAGE,
  RunWireSchema,
} from '../chat.types';

/**
 * HTTP DTOs for the chat routes.
 *
 * Inputs are validated by the global `ZodValidationPipe` the http-server
 * installs; outputs are declared with `@ZodResponse` on the controller, which
 * type-checks the handler's return value, serializes it through the schema, and
 * publishes the schema to the OpenAPI document the renderer's client is
 * generated from.
 *
 * A response DTO's ROOT schema must never carry a zod `.meta({ id })` — the
 * component takes the DTO class name instead, and an id there would leave array
 * responses pointing at a component that does not exist (guarded in
 * `setupSwagger`). Ids belong on the nested/shared schemas in `chat.types.ts`.
 */
export const createChatSchema = z.object({
  agentKind: AgentKindSchema,
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  /** Omitted = the service default (claude 'ask', cursor 'auto'). */
  approval: ChatApprovalModeSchema.optional(),
});
export class CreateChatDto extends createZodDto(createChatSchema) {}

export const updateChatSettingsSchema = z
  .object({
    approval: ChatApprovalModeSchema.optional(),
    /**
     * Explicit null clears the run back to the CLI's own default — the one
     * thing an omitted key (= leave unchanged) cannot say.
     */
    model: z.string().min(1).nullable().optional(),
  })
  .refine(
    (dto) => dto.approval !== undefined || dto.model !== undefined,
    'a settings patch must change the approval mode or the model',
  );
export class UpdateChatSettingsDto extends createZodDto(
  updateChatSettingsSchema,
) {}

export const sendMessageSchema = z
  .object({
    // Not `.min(1)`: an image alone is a complete message ("what's wrong with
    // this?" is carried by the screenshot). The refine below keeps the empty
    // message — no text AND no images — refused.
    text: z.string(),
    images: z
      .array(
        z.object({
          mediaType: AttachmentMediaTypeSchema,
          data: z.string().min(1).describe('base64-encoded image bytes'),
        }),
      )
      .max(MAX_ATTACHMENTS_PER_MESSAGE)
      .optional(),
  })
  .refine(
    (dto) => dto.text.trim().length > 0 || (dto.images?.length ?? 0) > 0,
    'a message needs text or at least one image',
  );
export class SendMessageDto extends createZodDto(sendMessageSchema) {}

export const renameRunSchema = z.object({
  /** New sidebar label for the run — non-blank, sanely bounded. */
  title: z.string().trim().min(1).max(200),
});
export class RenameRunDto extends createZodDto(renameRunSchema) {}

export const historyQuerySchema = z.object({
  /** Replay cursor — return only items with seq greater than this. */
  afterSeq: z.coerce.number().int().optional(),
});
export class HistoryQueryDto extends createZodDto(historyQuerySchema) {}

// ── Responses ───────────────────────────────────────────────────────────────

/** A run — a single-agent chat or a workflow execution. */
export class RunDto extends createZodDto(RunWireSchema) {}

/** One persisted transcript item. */
export class ItemDto extends createZodDto(ItemWireSchema) {}

/**
 * One attachment's bytes, base64 in JSON rather than a binary body: the daemon
 * gates every route on the bearer token, and an `<img src>` cannot carry an
 * Authorization header — so the renderer fetches through its generated client
 * and builds a data URL. The root schema carries no `.meta({ id })` (see above).
 */
export class AttachmentDataDto extends createZodDto(
  z.object({
    id: z.string(),
    mediaType: AttachmentMediaTypeSchema,
    data: z.string().describe('base64-encoded image bytes'),
  }),
) {}

/**
 * Acknowledgement of a cancel request. Shared with the workflow routes — the
 * cancel surface is identical for chat and graph runs.
 */
export class CancelledDto extends createZodDto(
  z.object({
    cancelled: z
      .boolean()
      .describe('True when a live turn was signalled to stop'),
  }),
) {}
