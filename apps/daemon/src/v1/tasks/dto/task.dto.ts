import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  AttachmentMediaTypeSchema,
  ChatApprovalModeSchema,
} from '../../agents/chat.types';
import { AgentKindSchema } from '../../runs/runs.types';
import {
  TASK_DESCRIPTION_MAX,
  TASK_LABEL_MAX,
  TASK_LABELS_MAX,
  TASK_SOURCE_REF_MAX,
  TASK_TITLE_MAX,
  TaskAttachmentSchema,
  TaskAwaitingMergeSchema,
  TaskPrioritySchema,
  TaskSourceSchema,
  TaskStatusSchema,
  TaskWireSchema,
} from '../tasks.types';

/**
 * HTTP DTOs for the task routes.
 *
 * Inputs are validated by the global `ZodValidationPipe` the http-server
 * installs; responses are declared with `@ZodResponse` on the controller,
 * which type-checks the handler's return value, serializes it through the
 * schema, and publishes the schema to the OpenAPI document the renderer's
 * client is generated from. A response DTO's ROOT schema carries no
 * `.meta({ id })` — see `chat.dto.ts` for why.
 */

/** A task's title — non-blank after trimming, sanely bounded. */
const taskTitleSchema = z.string().trim().min(1).max(TASK_TITLE_MAX);

const labelsSchema = z
  .array(z.string().trim().min(1).max(TASK_LABEL_MAX))
  .max(TASK_LABELS_MAX);

/**
 * Which project's board to list.
 *
 * A DTO rather than a bare `@Query('projectId')`, and the difference is not
 * stylistic: the global Zod pipe validates only when the parameter's metatype
 * is a `ZodDto`, so a raw param is passed through untouched. An absent one then
 * arrives as `undefined`, which `ignoreUndefinedInQuery` STRIPS from the filter
 * rather than matching — the existence guard resolved an arbitrary project and
 * the listing returned every task row in the database. `fastify-qs` also parses
 * `?projectId[$ne]=x` into an object, which MikroORM honours as an operator.
 * Both are refused here, before anything reaches the ORM — as a 403, not the
 * 400 the shape suggests: the vendored `ValidationException` carries that
 * status for every malformed body and query in this daemon.
 */
export const listTasksQuerySchema = z.object({
  projectId: z.string().min(1),
});
export class ListTasksQueryDto extends createZodDto(listTasksQuerySchema) {}

export const createTaskSchema = z.object({
  projectId: z.string().min(1),
  title: taskTitleSchema,
  description: z.string().max(TASK_DESCRIPTION_MAX).optional(),
  /** Omitted = `backlog`, where a jotted-down task belongs until it is queued. */
  status: TaskStatusSchema.optional(),
  labels: labelsSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  dueDate: z.iso.date().optional(),
  /** Omitted = run in the project's folder. See `Task.folder`. */
  folder: z.string().min(1).optional(),
  /**
   * The run configuration for THIS card, overriding the project's. Omitted
   * throughout means inherit, which is what makes the project's the default —
   * spelled exactly as `createProjectSchema` spells the same six fields.
   */
  agentKind: AgentKindSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  approval: ChatApprovalModeSchema.optional(),
  configDir: z.string().min(1).optional(),
  workflowSlug: z.string().min(1).optional(),
  source: TaskSourceSchema.optional(),
  sourceRef: z.string().min(1).max(TASK_SOURCE_REF_MAX).optional(),
});
export class CreateTaskDto extends createZodDto(createTaskSchema) {}

/**
 * What a client may change about a card — its OWN fields, and nothing of the
 * run working it.
 *
 * `runId`, `worktreePath`, `branch` and `reportItemId` are deliberately NOT
 * here, though `UpdateTaskInput` still carries them for the services. They are
 * the two ends of the run<->task edge and the run's own record, and
 * `TaskRunsService` guards every write to them: a synchronous claim, a
 * compare-and-set on the column, and a question put to the RUN rather than to
 * the id. A patch accepting them re-opened all three at once — clearing
 * `runId` on a card whose agent was live let the start path run a second agent
 * against the same worktree. Nothing in the renderer ever sent them; the route
 * simply accepted more than any caller needed, which is the shape a bypass
 * takes.
 */
export const updateTaskSchema = z
  .object({
    title: taskTitleSchema.optional(),
    /** Explicit null clears the description; an omitted key leaves it alone. */
    description: z.string().max(TASK_DESCRIPTION_MAX).nullable().optional(),
    labels: labelsSchema.optional(),
    priority: TaskPrioritySchema.optional(),
    dueDate: z.iso.date().nullable().optional(),
    /**
     * Explicit null hands the card back to the project's folder; an omitted key
     * leaves it alone. NULLABLE where create's is merely optional, because
     * "inherit again" is a thing a user does to a card that already names one
     * and there is no other way to say it.
     */
    folder: z.string().min(1).nullable().optional(),
    /**
     * The run configuration, on `folder`'s own contract above: explicit null
     * hands the field back to the project's default, an omitted key leaves it
     * alone. `updateProjectSchema` spells the same six identically.
     */
    agentKind: AgentKindSchema.nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    effort: z.string().min(1).nullable().optional(),
    approval: ChatApprovalModeSchema.nullable().optional(),
    configDir: z.string().min(1).nullable().optional(),
    workflowSlug: z.string().min(1).nullable().optional(),
  })
  .refine(
    (dto) => Object.values(dto).some((value) => value !== undefined),
    'a task patch must change at least one field',
  );
export class UpdateTaskDto extends createZodDto(updateTaskSchema) {}

/**
 * A status move, and why it carries the status the caller is moving FROM.
 *
 * The move is conditional: `from` is the status the caller believes the task
 * is currently in, and the service refuses the move when the row disagrees.
 * Two windows can hold the same board and a task is a thing an agent may
 * already be running, so a drag computed against a card that has since moved
 * must lose rather than overwrite. Sending only `to` would make the last
 * writer win, which is the outcome this exists to prevent.
 */
export const moveTaskStatusSchema = z.object({
  from: TaskStatusSchema,
  to: TaskStatusSchema,
});
export class MoveTaskStatusDto extends createZodDto(moveTaskStatusSchema) {}

/**
 * Which of a card's pull requests has been merged.
 *
 * The URL and nothing else, because the URL is the whole address — and it is
 * checked against what this card's run actually captured before anything
 * moves, so a caller cannot end a card by naming a pull request belonging to
 * somebody else's work. See `TaskMergeService.settleMerged`.
 */
export const reportPullRequestMergedSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe('The pull request, exactly as the awaiting-merge list gave it'),
});
export class ReportPullRequestMergedDto extends createZodDto(
  reportPullRequestMergedSchema,
) {}

// ── Responses ───────────────────────────────────────────────────────────────

/** One task. */
export class TaskDto extends createZodDto(TaskWireSchema) {}

/** One card in review, with the pull requests that could end it. */
export class TaskAwaitingMergeDto extends createZodDto(
  TaskAwaitingMergeSchema,
) {}

/** Acknowledgement of a task delete. */
export class TaskDeletedDto extends createZodDto(
  z.object({
    deleted: z.boolean().describe('True when the task row was removed'),
  }),
) {}

/**
 * The bytes of one picture pasted into a card's description.
 *
 * Base64 on the wire, like the chat composer's own attachments, and bounded
 * where the DECODED size is known — see `TaskAttachmentService.save`.
 */
export const addTaskAttachmentSchema = z.object({
  mediaType: AttachmentMediaTypeSchema,
  data: z.string().min(1).describe('The image bytes, base64-encoded'),
  name: z
    .string()
    .max(200)
    .optional()
    .describe('The file’s own name, when the clipboard carried one'),
});
export class AddTaskAttachmentDto extends createZodDto(
  addTaskAttachmentSchema,
) {}
export class TaskAttachmentDto extends createZodDto(TaskAttachmentSchema) {}

/**
 * A picture the description references, read back for the panel to draw.
 *
 * A QUERY parameter and not a path segment, matching the chat route it shares
 * a reader with: the value is a filesystem path and carries slashes of its own.
 */
export const taskImageQuerySchema = z.object({
  path: z.string().min(1),
});
export class TaskImageQueryDto extends createZodDto(taskImageQuerySchema) {}

/** A file the user picked, bound to a card by PATH — geniro copies nothing. */
export const attachTaskFileSchema = z.object({
  path: z.string().min(1).describe('An absolute path on this machine'),
});
export class AttachTaskFileDto extends createZodDto(attachTaskFileSchema) {}
