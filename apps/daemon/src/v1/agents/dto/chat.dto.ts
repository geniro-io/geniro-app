import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AgentKindSchema } from '../../runs/runs.types';
import {
  AttachmentMediaTypeSchema,
  ChatApprovalModeSchema,
  ChatMetricsWireSchema,
  ItemWireSchema,
  LocalImageWireSchema,
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
  /**
   * Reasoning effort in the CLI's own vocabulary; omitted = its default. A
   * plain string here and checked against the adapter's `listEfforts()` in
   * the service — an enum would pin one CLI's levels into the shared schema.
   */
  effort: z.string().min(1).optional(),
  /**
   * The agent config directory this chat's turns run under — the folder
   * holding that CLI's credentials, settings and plugins, so one chat can run
   * on a different ACCOUNT (a different subscription) than the next. Omitted =
   * the CLI's own default profile.
   *
   * Only a shape check here: whether the path EXISTS (and its canonical form),
   * and whether this CLI has such a mechanism at all, are the service's job —
   * `resolveValidConfigDir` and the adapter's own
   * `AdapterConfig.configDir.unavailableReason`.
   */
  configDir: z.string().min(1).optional(),
  /**
   * A conversation this CLI already holds (`GET /v1/agents/sessions`), taken
   * over by the new thread instead of a fresh session being started.
   *
   * Opaque here: only the adapter that listed it may interpret it, so the
   * schema checks nothing but that a value was sent. What it MEANS for `cwd`
   * is worth stating — the folder must be the session's own, which the picker
   * takes from the listing rather than from the composer, since resuming a
   * conversation about one project inside another is how a resumed thread
   * starts reasoning about the wrong tree.
   */
  resumeSessionId: z.string().min(1).optional(),
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
    /** Same null-vs-omitted contract as `model` above. */
    effort: z.string().min(1).nullable().optional(),
  })
  .refine(
    (dto) =>
      dto.approval !== undefined ||
      dto.model !== undefined ||
      dto.effort !== undefined,
    'a settings patch must change the approval mode, the model or the effort',
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

/** Which file on disk a markdown image reference names. */
export class LocalImageQueryDto extends createZodDto(
  z.object({
    path: z
      .string()
      .describe(
        'the image reference as the agent wrote it; a relative one is resolved against the run cwd',
      ),
  }),
) {}

/**
 * One agent-referenced local image's bytes — same base64-in-JSON shape as
 * {@link AttachmentDataDto}, and for the same two reasons: every route is
 * bearer-gated and an `<img src>` cannot carry the header, so the renderer
 * fetches through its generated client and builds a data URL. It echoes the
 * PATH rather than an id because that is the only handle the caller has — the
 * daemon minted nothing here.
 */
export class LocalImageDto extends createZodDto(LocalImageWireSchema) {}

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

/**
 * Acknowledgement of a delete. Mirrors the workflow route's own `DeletedDto`
 * rather than sharing it: they belong to different modules' contracts, and the
 * generated client names one class per tag.
 */
export class DeletedDto extends createZodDto(
  z.object({
    deleted: z
      .boolean()
      .describe('True when the chat and everything it owned were removed'),
  }),
) {}

/**
 * What one chat's window holds and what the thread has cost.
 *
 * The schema itself lives in `chat.types.ts` beside the type it derives, like
 * every other wire shape in this module. Re-stating it here is what the
 * metrics types used to do — a hand-written `ChatMetricsWire` interface on one
 * side and an independent schema on the other — and a field added to only one
 * of them type-checks, serializes away, and never reaches this client: the
 * compile-time half constrains the handler's return to the schema's INPUT
 * type, and excess-property checks do not apply to a value that is not an
 * object literal.
 */
export class ChatMetricsDto extends createZodDto(ChatMetricsWireSchema) {}
