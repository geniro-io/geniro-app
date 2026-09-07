import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ChatApprovalModeSchema } from '../../agents/chat.types';
import { AgentKindSchema } from '../../runs/runs.types';
import { TaskSourceSchema, TaskStatusSchema } from '../../tasks/tasks.types';
import {
  PROJECT_MAX_CONCURRENT_CEILING,
  PROJECT_NAME_MAX,
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

// The three autopilot policy fields are deliberately absent from both input
// schemas below: they are READ over the wire and not yet WRITTEN. Their columns
// exist because the parent spec fixes the Project field list, but nothing acts
// on them until the conductor lands, and a route that accepts a setting it will
// not honour is a contract the daemon does not keep — worse on a committed
// client, where the field reads as live. The setters arrive with the behaviour;
// `schema.update({ safe: true })` adds a defaulted column additively, so
// landing them now would save no migration later.

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
  })
  .refine(
    (dto) => Object.values(dto).some((value) => value !== undefined),
    'a project patch must change at least one field',
  );
export class UpdateProjectDto extends createZodDto(updateProjectSchema) {}

// ── Responses ───────────────────────────────────────────────────────────────

/** One project. */
export class ProjectDto extends createZodDto(ProjectWireSchema) {}

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
