import { z } from 'zod';

/**
 * The board's columns, and the whole vocabulary a task's status may take.
 *
 * Fixed rather than per-project, deliberately: a provider adapter (Linear,
 * Jira) maps ONTO this set and never the reverse, so a column one user
 * invented on one board would be a mapping target that exists nowhere else.
 *
 * `failed` is a status of the TASK, not a reading of its last run. The
 * autopilot's breaker needs somewhere to park a task that keeps failing —
 * left in the intake column it would be picked up again on the next sweep,
 * and again after that.
 */
export const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'failed',
] as const;
export const TaskStatusSchema = z
  .enum(TASK_STATUSES)
  .meta({ id: 'TaskStatus' });
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Where a task came from.
 *
 * Only `geniro` today — one the user typed into this app. The field exists
 * before a second source does because it is what an adapter will stamp, and
 * adding it afterwards would mean deciding retroactively what every row
 * already on disk had been.
 */
export const TASK_SOURCES = ['geniro'] as const;
export const TaskSourceSchema = z.enum(TASK_SOURCES).meta({ id: 'TaskSource' });
export type TaskSource = z.infer<typeof TaskSourceSchema>;

/** A task's title — non-blank after trimming, sanely bounded. */
export const TASK_TITLE_MAX = 200;

/**
 * How long a task's free text may be.
 *
 * Bounded here rather than left to Fastify's `bodyLimit`, which is ~54MB and
 * would let one description become a 54MB TEXT column. `description` is
 * heading for an agent's brief, so it is the daemon's to bound independently
 * of whatever the client allows — the same rule `CustomInstructionsSchema`
 * states for a separate process validating untrusted input.
 */
export const TASK_DESCRIPTION_MAX = 20_000;
export const TASK_SOURCE_REF_MAX = 200;

/** How many labels one task may carry, and how long each may be. */
export const TASK_LABELS_MAX = 20;
export const TASK_LABEL_MAX = 40;

/**
 * One task on the wire.
 *
 * No `.meta({ id })` on this ROOT: it backs an array response DTO, and an id
 * here would register the component under that name while the array response
 * still points at the DTO class — the dangling `$ref` `setupSwagger` fails the
 * boot on.
 */
export const TaskWireSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: TaskStatusSchema,
  labels: z.array(z.string()),
  source: TaskSourceSchema,
  sourceRef: z
    .string()
    .nullable()
    .describe(
      "The id this task carries in the system it came from — null for a task made here, since geniro's own id is the one above",
    ),
  branch: z
    .string()
    .nullable()
    .describe('The branch an agent works this task on; null until one runs'),
  worktreePath: z
    .string()
    .nullable()
    .describe(
      'The worktree that branch is checked out in; null until one runs',
    ),
  runId: z
    .string()
    .nullable()
    .describe('The chat run currently serving this task, if any'),
  reportItemId: z
    .string()
    .nullable()
    .describe(
      "The transcript item holding the agent's report, so the card can show it without replaying the run",
    ),
  position: z
    .number()
    .int()
    .describe(
      'Order within the column, ascending and unique — gaps are expected, since a delete or a move leaves one and nothing renumbers',
    ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TaskWire = z.infer<typeof TaskWireSchema>;

/**
 * What a status move must send: the status the caller believes the task is
 * currently in, alongside the one it should move to.
 *
 * The `from` half is what makes the move CONDITIONAL. Two windows can hold the
 * same board, and a task is a thing an agent may already be running — so a
 * move computed against a stale card must lose rather than overwrite. See
 * `TasksService.moveStatus`.
 */
export interface TaskStatusMove {
  from: TaskStatus;
  to: TaskStatus;
}

/**
 * A task write the board needs to hear about, over the WS `task_changed`
 * broadcast — see {@link TaskEventBus}.
 *
 * Deliberately thin: `status` (rather than the whole {@link TaskWire}) is what
 * a board draws a card by, and the renderer already holds the rest from its
 * own fetch — a wider payload would be a second, driftable copy of the row.
 */
/**
 * TWIN PARSER: mirrored by the renderer's `parseTaskChanged`
 * (`apps/ui/src/renderer/daemon-client.ts`). Change one and change the other.
 */
export interface TaskChangedEvent {
  taskId: string;
  projectId: string;
  status: TaskStatus;
}
