import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  TASK_DESCRIPTION_MAX,
  TASK_LABEL_MAX,
  TASK_LABELS_MAX,
  TASK_SOURCE_REF_MAX,
  TASK_TITLE_MAX,
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

// ── Responses ───────────────────────────────────────────────────────────────

/** One task. */
export class TaskDto extends createZodDto(TaskWireSchema) {}

/** Acknowledgement of a task delete. */
export class TaskDeletedDto extends createZodDto(
  z.object({
    deleted: z.boolean().describe('True when the task row was removed'),
  }),
) {}
