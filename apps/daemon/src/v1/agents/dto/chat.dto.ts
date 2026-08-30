import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AgentKindSchema } from '../../runs/runs.types';
import {
  AttachmentMediaTypeSchema,
  ChatApprovalModeSchema,
  ChatExportWireSchema,
  ChatMetricsWireSchema,
  ChatTotalsResponseSchema,
  CustomInstructionsSchema,
  ItemWireSchema,
  LocalImageWireSchema,
  MAX_ATTACHMENTS_PER_MESSAGE,
  RunWireSchema,
  ShellOutputWireSchema,
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
   * plain string here and checked by `EffortsService.accepts` in the service —
   * against the adapter's `listEfforts()` for a CLI whose list is complete, and
   * against the NAMED MODEL's own listing otherwise. An enum would pin one
   * CLI's levels into the shared schema.
   */
  effort: z.string().min(1).optional(),
  /**
   * Which of the model's context-window sizes to run at, in the CLI's own
   * vocabulary; omitted = the model's own default.
   *
   * A plain string, like `effort`, and for the identical reason — the sizes are
   * a per-MODEL vocabulary the adapter owns (`300k`, `1m`, `272k`), so an enum
   * would pin one CLI's words into the shared schema. Unlike effort it is NOT
   * checked up front: there is no CLI-wide superset to check against (a size
   * means nothing apart from its model), and the turn's own driver reports on
   * the transcript when a value does not apply — which is per turn, against
   * the live agent, rather than against a constant that goes stale.
   */
  contextWindow: z.string().min(1).optional(),
  /**
   * Every OTHER model setting this chat's turns ask for, keyed by the CLI's
   * own parameter id (`{optimize_for: 'intelligence'}`).
   *
   * Plain strings on both sides, and checked NOWHERE up front, for the reason
   * the window above is not — only more so: geniro holds no vocabulary for
   * these at all (see `AgentModelParameter`), so there is nothing here that
   * could be checked against. The model is asked what it accepts
   * (`GET /v1/agents/model-parameters`) and the live agent refuses a value it
   * does not, on the turn, with a sentence.
   *
   * Bounded because the values ride a config option on every turn for the life
   * of the chat — the caps live with the column's own reader
   * (`utils/model-parameters.ts`), which is also what sanitizes this map.
   */
  modelParameters: z.record(z.string(), z.string()).optional(),
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
   * The user's global custom instructions, snapshotted onto this run at
   * creation — free prose the composer reads out of the app's own settings,
   * not something typed per chat.
   *
   * Sent by the client rather than read daemon-side because settings live in
   * the ELECTRON process (`settings.json`), which the daemon does not open;
   * the same route `configDir` already travels. Bounded here INDEPENDENTLY of
   * the renderer's own bound: this is a separate process validating untrusted
   * input, and the value ends up in a child's argv, so the daemon may not rely
   * on a client having checked it. The ceiling is far under the OS argv limit
   * and far over any plausible prose.
   */
  customInstructions: CustomInstructionsSchema.optional(),
  /**
   * Ask cursor for **Max Mode** on this run's turns — the user's own setting,
   * snapshotted onto the run ({@link Run.cursorMaxMode}).
   *
   * Sent by the client for the reason `customInstructions` is: the setting
   * lives in the ELECTRON process's `settings.json`, which the daemon never
   * opens. OMITTED means "the client did not say", which the adapter reads as
   * its own default — not as OFF.
   */
  cursorMaxMode: z.boolean().optional(),
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
    /** Same again — and cleared to null whenever the MODEL changes, since a
     * window size belongs to the model that offered it. */
    contextWindow: z.string().min(1).nullable().optional(),
    /**
     * Same again, and cleared by a model change for a sharper version of the
     * same reason: `optimize_for` exists on ONE model of thirty-four, so
     * carrying a pick across a switch sends an option the new model has never
     * heard of. An explicit `{}` clears them; null does the same.
     */
    modelParameters: z.record(z.string(), z.string()).nullable().optional(),
    /**
     * Which ACCOUNT this thread's next turns run as — the agent config
     * directory, or an explicit null for the CLI's own default profile.
     *
     * This route used to refuse the field on the reading that a config
     * directory is part of a run's IDENTITY, like its folder. That was true of
     * everything except what the user actually wanted from it: REPORTED as "I
     * wanna have ability to dynamically change config directory for current
     * claude threads to have an ability continue thread with other account".
     * A folder decides what the conversation is ABOUT; a profile decides who is
     * paying for it and what tools they have, and neither is a fact about the
     * words already said.
     *
     * The switch does more than write a column — the conversation is carried
     * into the new profile and the run's live process is retired — so unlike
     * `model` and `effort` this one is REFUSED while a turn is running. See
     * `ChatService.updateSettings`.
     */
    configDir: z.string().min(1).nullable().optional(),
  })
  .refine(
    (dto) =>
      dto.approval !== undefined ||
      dto.model !== undefined ||
      dto.effort !== undefined ||
      dto.contextWindow !== undefined ||
      dto.modelParameters !== undefined ||
      dto.configDir !== undefined,
    'a settings patch must change the approval mode, the model, the effort, the context window, a model parameter or the config directory',
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
  /**
   * At most this many items, taken from the END of the conversation — the
   * newest ones. Absent means the whole transcript, which is what the reconnect
   * replay wants and what every caller did before paging existed.
   *
   * Bounded here rather than trusted: this is the one query whose cost scales
   * with a number the client picks, and a thread of 7,814 items is 18.9MB.
   */
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  /**
   * Page BACKWARDS: only items before this seq. Paired with `limit` to walk a
   * long conversation towards its start, one window at a time.
   */
  beforeSeq: z.coerce.number().int().optional(),
});
export class HistoryQueryDto extends createZodDto(historyQuerySchema) {}

export const listChatsQuerySchema = z.object({
  /**
   * Which side of the archive to list — absent or false is the desk, true is
   * the shelf. Never both: an archived thread the user filed away must not
   * reappear in the list they filed it out of.
   *
   * `z.stringbool()` for the reason `mcp.dto.ts`'s `refresh` uses it: under
   * `z.coerce.boolean()` the string `"false"` a query string actually carries
   * is truthy, so an explicit `archived=false` would hand back the archive.
   */
  archived: z.stringbool().optional(),
});
export class ListChatsQueryDto extends createZodDto(listChatsQuerySchema) {}

// ── Responses ───────────────────────────────────────────────────────────────

/** A run — a single-agent chat or a workflow execution. */
export class RunDto extends createZodDto(RunWireSchema) {}

/** One persisted transcript item. */
export class ItemDto extends createZodDto(ItemWireSchema) {}

/** One whole conversation as a file — settings, transcript, nodes, spend. */
export class ChatExportDto extends createZodDto(ChatExportWireSchema) {}

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

/** Which command's terminal to open — the tool call that started it. */
export class ShellOutputQueryDto extends createZodDto(
  z.object({
    callId: z
      .string()
      .describe(
        'the id of the tool call that started the command, as the CLI spelled it',
      ),
  }),
) {}

/**
 * One shell command's output — the tail of the file a DETACHED command is still
 * writing, or the reply a foreground one already returned.
 *
 * One route for both, because the panel's rows do not distinguish them: a user
 * clicking a running command wants what it has printed, and which of the two
 * mechanisms holds that text is the daemon's problem, not theirs.
 */
export class ShellOutputDto extends createZodDto(ShellOutputWireSchema) {}

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
 * How many runs had their snapshotted custom instructions forgotten.
 *
 * A COUNT rather than a bare ack because the action is silent otherwise: the
 * user is told what their press actually reached, which is also the only way
 * "nothing to forget" is distinguishable from "it did not work".
 */
export class ForgottenInstructionsDto extends createZodDto(
  z.object({
    cleared: z
      .number()
      .int()
      .describe('Runs whose snapshotted custom instructions were cleared'),
  }),
) {}

/**
 * Acknowledgement of a delete. Mirrors the workflow route's own
 * `WorkflowDeletedDto` rather than sharing it: they belong to different
 * modules' contracts, and the generated client names one class per tag.
 *
 * Prefixed because the OpenAPI component namespace is GLOBAL — two classes both
 * called `DeletedDto` land on one component name with two different bodies,
 * which @nestjs/swagger reports as a duplicate DTO today and will throw on in
 * its next major.
 */
export class ChatDeletedDto extends createZodDto(
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

/** The thread's spend alone — see `ChatTotalsResponseSchema` for why wrapped. */
export class ChatTotalsDto extends createZodDto(ChatTotalsResponseSchema) {}
