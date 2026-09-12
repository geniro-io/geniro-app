import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  ChatApprovalModeSchema,
  CustomInstructionsSchema,
} from '../../agents/chat.types';
import { commitShaSchema } from '../../agents/dto/chat.dto';
import { AgentKindSchema } from '../../runs/runs.types';
import {
  TASK_RUN_PROMPT_MAX,
  TaskRunStarterSchema,
  TaskStatusSchema,
} from '../tasks.types';

/**
 * HTTP DTOs for starting a task's run and recording its report.
 *
 * Validated by the global `ZodValidationPipe`; responses are declared with
 * `@ZodResponse` on the controller. See `task.dto.ts` for the fuller note on
 * why a response DTO's root schema carries no `.meta({ id })`.
 */

/**
 * Start a run for one task.
 *
 * The CWD and BRANCH come from the caller because the daemon runs no git: the
 * Electron main process prepares the worktree and names the branch, and this
 * route records what it was told. A daemon that derived either would be the
 * one thing this app's git discipline forbids.
 */
export const startTaskRunSchema = z.object({
  cwd: z
    .string()
    .min(1)
    .describe(
      'The worktree the agent works in — already created by the caller, and validated here only as a real directory',
    ),
  branch: z
    .string()
    .min(1)
    .describe('The branch that worktree has checked out'),
  /**
   * The status the caller believes the task is in, on `moveTaskStatus`'s own
   * terms: starting a run moves the card, so a start computed against a card
   * that has since moved must lose rather than overwrite.
   */
  from: TaskStatusSchema,
  /**
   * What `cwd` had checked out at this moment, read by the CLIENT — the fixed
   * point the diff view measures against, exactly as chat create takes it.
   */
  startSha: commitShaSchema.optional(),
  startDirty: z.boolean().optional(),
  /**
   * The user's own words for this press — a nudge, a correction, the next
   * thing to do — on top of what the card already says.
   *
   * It is what makes a SECOND press of Run useful at all: a card whose thread
   * already exists is continued rather than restarted, and this is the message
   * that continues it. Absent means the press said nothing, which is a real
   * answer and the ordinary one for a card being run the first time.
   */
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(TASK_RUN_PROMPT_MAX)
    .optional()
    .describe('Extra instructions for this one press, on top of the card'),
  /**
   * The run configuration for this one press.
   *
   * Every field is optional and falls back to the CARD's own answer and then to
   * the PROJECT's, so a board that sends nothing still runs the setup the user
   * chose for that card or that project. Values whose vocabulary belongs to a
   * CLI stay opaque strings — the daemon validates them against that adapter's
   * own list, not against an enum this app would have to release to extend.
   *
   * What a press may NOT decide is an unattended run's approval mode: an
   * autopilot start is forced to `auto` whatever arrives here or stands on
   * either row, because every other mode can stop and ask a human who is by
   * definition not there. See `AUTOPILOT_APPROVAL`, which states why.
   */
  agentKind: AgentKindSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  approval: ChatApprovalModeSchema.optional(),
  configDir: z.string().min(1).optional(),
  workflowSlug: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Run this press through a workflow instead of a single agent; outranks every agent field above',
    ),
  /**
   * The user's own standing instructions, sent by the client because they live
   * in the Electron process's `settings.json` — the same road chat create
   * takes them by. geniro's request for a closing report is APPENDED to these
   * rather than replacing them, so a task run still honours what the user told
   * every agent.
   */
  customInstructions: CustomInstructionsSchema.optional(),
  /**
   * WHO pressed Run — the person, or the autopilot timer in the Electron
   * process. Absent reads as `user`.
   *
   * It has to be on the SCHEMA and not merely on the service's input type:
   * zod strips unknown keys, so a field the DTO does not declare never reaches
   * the service however faithfully the client sends it — and three controls
   * key off this one. The concurrency cap and the failure breaker refuse an
   * unattended start; `resolveRunTarget` forces the approval mode an unattended
   * run must have, and refuses a workflow it could not force one for. Each is
   * documented as the line the queue's own narrowing is only a convenience in
   * front of, so each is inert while this is dropped at the edge.
   */
  startedBy: TaskRunStarterSchema.optional().describe(
    'Who pressed Run — `user` (default) or the `autopilot` timer, which is held to the project cap, the failure breaker and a forced approval mode',
  ),
});
export class StartTaskRunDto extends createZodDto(startTaskRunSchema) {}

/**
 * Which board to catch up.
 *
 * A DTO rather than a bare query param, on `ListTasksQueryDto`'s own
 * reasoning: the global Zod pipe validates only a `ZodDto` metatype, so a raw
 * parameter reaches the ORM unchecked.
 */
export const reconcileTasksSchema = z.object({
  projectId: z.string().min(1),
});
export class ReconcileTasksDto extends createZodDto(reconcileTasksSchema) {}

/**
 * Which of these tasks' work is finished — asked by the Electron main process
 * about the worktrees its registry still holds.
 *
 * A list, because that process knows which directories exist and nothing about
 * what became of their cards; bounded, because it is only ever as long as the
 * cards whose worktrees are still on disk.
 */
export const findFinishedTasksSchema = z.object({
  taskIds: z.array(z.string().min(1).max(200)).max(1000),
});
export class FindFinishedTasksDto extends createZodDto(
  findFinishedTasksSchema,
) {}

/**
 * TWIN PARSER: read by `readFinishedTasks` in
 * `apps/ui/src/main/finished-tasks.ts`, which takes this reply without the
 * generated client (that one is the renderer's). Change one and change the
 * other.
 */
export class FinishedTasksDto extends createZodDto(
  z.object({
    taskIds: z
      .array(z.string())
      .describe(
        'The subset whose work is finished — Done with no run working in it, or no longer a card at all',
      ),
  }),
) {}
