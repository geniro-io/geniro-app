import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ChatApprovalModeSchema } from '../../agents/chat.types';
import { AgentKindSchema } from '../../runs/runs.types';
import { TaskSourceSchema, TaskStatusSchema } from '../../tasks/tasks.types';
import {
  PROJECT_MAX_CONCURRENT_CEILING,
  PROJECT_NAME_MAX,
  ProjectQueueSchema,
  ProjectWireSchema,
} from '../projects.types';

/**
 * HTTP DTOs for the project routes.
 *
 * Inputs are validated by the global `ZodValidationPipe` the http-server
 * installs; responses are declared with `@ZodResponse` on the controller,
 * which type-checks the handler's return value, serializes it through the
 * schema, and publishes the schema to the OpenAPI document the renderer's
 * client is generated from. A response DTO's ROOT schema carries no
 * `.meta({ id })` — see `chat.dto.ts` for why.
 */

/** A project's name — non-blank after trimming, sanely bounded. */
const projectNameSchema = z.string().trim().min(1).max(PROJECT_NAME_MAX);

/**
 * The autopilot POLICY — what the user decides, and the whole of what a client
 * may write.
 *
 * `autopilotFailureStreak` is deliberately not here. It is the breaker's own
 * running count, written by the daemon as runs settle, and a client that could
 * set it could hold the breaker open or clear it without re-arming — which is
 * the one act the breaker exists to make deliberate. Re-arming has its own
 * route for that reason.
 */
const autopilotPolicy = {
  autopilotEnabled: z.boolean(),
  autopilotIntakeStatus: TaskStatusSchema,
  /**
   * Bounded at the SCHEMA rather than clamped in the service: each concurrent
   * task takes its own git worktree, so a client asking for fifty is refused
   * with the ceiling named instead of quietly getting five and believing it
   * got fifty.
   */
  autopilotMaxConcurrent: z
    .number()
    .int()
    .min(1)
    .max(PROJECT_MAX_CONCURRENT_CEILING),
};

export const createProjectSchema = z.object({
  name: projectNameSchema,
  /**
   * Checked and canonicalized by the service before it is stored: a project
   * pointing at a folder that does not exist could never run a task.
   */
  folder: z.string().min(1),
  groupId: z.string().min(1).optional(),
  agentKind: AgentKindSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  approval: ChatApprovalModeSchema.optional(),
  configDir: z.string().min(1).optional(),
  workflowSlug: z.string().min(1).optional(),
  provider: TaskSourceSchema.optional(),
  autopilotEnabled: autopilotPolicy.autopilotEnabled.optional(),
  autopilotIntakeStatus: autopilotPolicy.autopilotIntakeStatus.optional(),
  autopilotMaxConcurrent: autopilotPolicy.autopilotMaxConcurrent.optional(),
});
export class CreateProjectDto extends createZodDto(createProjectSchema) {}

export const updateProjectSchema = z
  .object({
    name: projectNameSchema.optional(),
    folder: z.string().min(1).optional(),
    /**
     * Explicit null clears the binding — the one thing an omitted key (= leave
     * unchanged) cannot say, the same contract the sidebar group's patch uses
     * for `autoCwd`. Every nullable field below reads the same way.
     */
    groupId: z.string().min(1).nullable().optional(),
    agentKind: AgentKindSchema.nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    effort: z.string().min(1).nullable().optional(),
    approval: ChatApprovalModeSchema.nullable().optional(),
    configDir: z.string().min(1).nullable().optional(),
    workflowSlug: z.string().min(1).nullable().optional(),
    /**
     * The three policy fields break the nullable pattern of every field above
     * them, and the reason is the column: these are NOT NULL with defaults, so
     * there is no "unset" state for a null to mean. Omitting the key is the
     * only way to leave one alone.
     */
    autopilotEnabled: autopilotPolicy.autopilotEnabled.optional(),
    autopilotIntakeStatus: autopilotPolicy.autopilotIntakeStatus.optional(),
    autopilotMaxConcurrent: autopilotPolicy.autopilotMaxConcurrent.optional(),
  })
  .refine(
    (dto) => Object.values(dto).some((value) => value !== undefined),
    'a project patch must change at least one field',
  );
export class UpdateProjectDto extends createZodDto(updateProjectSchema) {}

// ── Responses ───────────────────────────────────────────────────────────────

/** One project. */
export class ProjectDto extends createZodDto(ProjectWireSchema) {}

/** What one project's autopilot may start right now. */
export class ProjectQueueDto extends createZodDto(ProjectQueueSchema) {}

/**
 * Acknowledgement of a project delete. It reports how many tasks went with it,
 * because they DO go with it — unlike a sidebar group, which releases its runs.
 * A board is the project; there is nowhere for its cards to be released to.
 */
export class ProjectDeletedDto extends createZodDto(
  z.object({
    deleted: z.boolean().describe('True when the project row was removed'),
    tasksRemoved: z
      .number()
      .int()
      .describe('How many of its tasks were removed with it'),
  }),
) {}
