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
export class LocalImageDto extends createZodDto(
  z.object({
    path: z.string(),
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
 * One line item of the context window — named components so the generated
 * client gets real types instead of an inline anonymous shape per field.
 */
const ContextCategorySchema = z
  .object({
    name: z.string().describe("the CLI's own name for this part of the window"),
    tokens: z.number(),
    deferred: z
      .boolean()
      .describe(
        'available but not loaded, and so NOT counted in totalTokens — rendering it in the same bar reports a window several times fuller than it is',
      ),
  })
  .meta({ id: 'ContextCategory' });

const ContextMemoryFileSchema = z
  .object({
    path: z.string(),
    kind: z
      .string()
      .nullable()
      .describe(
        "the CLI's own word for where it came from (Project, AutoMem…)",
      ),
    tokens: z.number(),
  })
  .meta({ id: 'ContextMemoryFile' });

const ContextServerSchema = z
  .object({
    name: z.string(),
    tokens: z.number().describe("this server's whole tool surface, summed"),
    toolCount: z.number(),
    loadedToolCount: z
      .number()
      .describe('how many of them are actually in the window right now'),
  })
  .meta({ id: 'ContextServer' });

const ContextBreakdownSchema = z
  .object({
    categories: z.array(ContextCategorySchema),
    totalTokens: z.number().nullable(),
    maxTokens: z.number().nullable(),
    model: z.string().nullable(),
    autoCompactAtTokens: z
      .number()
      .nullable()
      .describe('where this CLI would compact the conversation by itself'),
    autoCompactEnabled: z.boolean().nullable(),
    memoryFiles: z.array(ContextMemoryFileSchema),
    servers: z.array(ContextServerSchema),
  })
  .meta({ id: 'ContextBreakdown' });

const ChatTotalsSchema = z
  .object({
    turns: z.number().describe('turns that reported usage'),
    costUsd: z.number().nullable(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    cacheReadTokens: z.number().nullable(),
    cacheCreationTokens: z.number().nullable(),
    thinkingTokens: z.number().nullable(),
    workedMs: z
      .number()
      .nullable()
      .describe("the CLI's own working time, where it reported one"),
  })
  .meta({ id: 'ChatTotals' });

/**
 * What one chat's window holds and what the thread has cost.
 *
 * The root schema carries no `.meta({ id })` — a response DTO's does not, or
 * nestjs-zod registers the component under the id while the DTO class name is
 * still what array responses `$ref`, and `setupSwagger` fails the boot on the
 * dangling reference.
 */
export class ChatMetricsDto extends createZodDto(
  z.object({
    context: ContextBreakdownSchema.nullable(),
    breakdownReason: z
      .string()
      .nullable()
      .describe(
        'why there is no breakdown — a CLI without the channel, or a chat with no running agent to ask',
      ),
    totals: ChatTotalsSchema,
  }),
) {}
