import { z } from 'zod';

import { ChatApprovalModeSchema } from '../agents/chat.types';
import { AgentKindSchema } from '../runs/runs.types';
import { TaskSourceSchema, TaskStatusSchema } from '../tasks/tasks.types';

/** A project's name — non-blank after trimming, sanely bounded. */
export const PROJECT_NAME_MAX = 120;

/**
 * How many tasks one project may run at once, at most.
 *
 * A ceiling on the setting, not the setting: each running task takes its own
 * git worktree, which on a repo with a real `node_modules` is a full working
 * copy on disk. The default is 1 for the same reason.
 */
export const PROJECT_MAX_CONCURRENT_CEILING = 5;
export const PROJECT_DEFAULT_MAX_CONCURRENT = 1;

/**
 * How many autopilot runs may fail in a row before the project stops picking
 * work up.
 *
 * The number answers "how many failures is enough to be a pattern rather than
 * bad luck", and three is the smallest count that can tell the two apart. It
 * is not a setting: a user who wants a longer leash wants the runs to succeed,
 * and a knob here only delays the moment they look at why they do not.
 */
export const PROJECT_FAILURE_BREAKER_THRESHOLD = 3;

/**
 * One project on the wire.
 *
 * No `.meta({ id })` on this ROOT: it backs an array response DTO, and an id
 * here would register the component under that name while the array response
 * still points at the DTO class — the dangling `$ref` `setupSwagger` fails the
 * boot on.
 *
 * The run-configuration half (`agentKind` / `model` / `effort` / `approval` /
 * `configDir`) is nullable throughout and carries the daemon's own vocabulary
 * rather than a second copy of it. Each null means "unset — fall back to
 * whatever the composer would have used", which is why none of them has a
 * default here: a project that has never been configured must not silently
 * pin an agent the user did not choose.
 */
export const ProjectWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  folder: z
    .string()
    .describe('The absolute project folder every task in it is worked in'),
  groupId: z
    .string()
    .nullable()
    .describe(
      "The chat-sidebar group this project's task runs file themselves into; null until one is bound",
    ),
  agentKind: AgentKindSchema.nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  approval: ChatApprovalModeSchema.nullable(),
  configDir: z.string().nullable(),
  workflowSlug: z
    .string()
    .nullable()
    .describe('A workflow to run a task through instead of a single agent'),
  autopilotEnabled: z.boolean(),
  autopilotIntakeStatus: TaskStatusSchema.describe(
    'The column the autopilot picks work up from',
  ),
  autopilotMaxConcurrent: z.number().int(),
  autopilotFailureStreak: z
    .number()
    .int()
    .describe(
      'Consecutive failed autopilot runs — the breaker reads it, and a success resets it to 0',
    ),
  provider: TaskSourceSchema.describe(
    "Where this project's tasks come from — the value its tasks carry as their own source",
  ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProjectWire = z.infer<typeof ProjectWireSchema>;

/**
 * One card the autopilot may pick up, and only what starting it needs.
 *
 * Deliberately not the board's own `TaskWireSchema`: this is a work handout
 * rather than a listing, and the caller is a conductor that starts runs, not a
 * screen that draws cards. `status` rides along because the start route is a
 * compare-and-set — it is the `from` the conductor must send back.
 */
export const QueuedTaskSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: TaskStatusSchema,
    position: z.number().int(),
  })
  .meta({ id: 'QueuedTask' });
export type QueuedTask = z.infer<typeof QueuedTaskSchema>;

/**
 * What one project's autopilot may do right now.
 *
 * `eligible` is the answer to "what should I start", already narrowed to the
 * free slots and empty whenever nothing may start at all — autopilot off, the
 * breaker open, or every slot taken. The route refuses to hand out work past
 * the cap rather than reporting a queue and trusting the conductor to count,
 * because the daemon is the only place that can see every window's runs.
 *
 * `waiting` is the whole intake column, so a screen can say how much is queued
 * behind what may start. No `.meta({ id })` on this ROOT — it backs a response
 * DTO; see `ProjectWireSchema` above.
 */
export const ProjectQueueSchema = z.object({
  projectId: z.string(),
  enabled: z.boolean().describe('Whether this project is armed'),
  intakeStatus: TaskStatusSchema.describe('The column work is picked up from'),
  cap: z.number().int().describe('How many tasks may run at once'),
  running: z
    .number()
    .int()
    .describe('How many of this project’s tasks hold a run that is still live'),
  waiting: z
    .number()
    .int()
    .describe('How many tasks sit in the intake column in total'),
  breakerOpen: z
    .boolean()
    .describe('True once consecutive failures reached the threshold'),
  failureStreak: z.number().int(),
  eligible: z
    .array(QueuedTaskSchema)
    .describe('The tasks that may be started now, oldest first'),
});
export type ProjectQueue = z.infer<typeof ProjectQueueSchema>;
