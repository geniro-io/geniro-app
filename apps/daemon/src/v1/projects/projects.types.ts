import { z } from 'zod';

import { AgentKindSchema } from '../runs/runs.types';
import { ChatApprovalModeSchema } from '../agents/chat.types';
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
