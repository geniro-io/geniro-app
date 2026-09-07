import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  ChatApprovalModeSchema,
  CustomInstructionsSchema,
} from '../../agents/chat.types';
import { commitShaSchema } from '../../agents/dto/chat.dto';
import { AgentKindSchema } from '../../runs/runs.types';
import { TaskStatusSchema } from '../tasks.types';

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
   * The run configuration for this one press.
   *
   * Every field is optional and falls back to the PROJECT's standing answer,
   * so a board that sends nothing still runs the setup the user chose for that
   * project. Values whose vocabulary belongs to a CLI stay opaque strings —
   * the daemon validates them against that adapter's own list, not against an
   * enum this app would have to release to extend.
   */
  agentKind: AgentKindSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  approval: ChatApprovalModeSchema.optional(),
  configDir: z.string().min(1).optional(),
  /**
   * The user's own standing instructions, sent by the client because they live
   * in the Electron process's `settings.json` — the same road chat create
   * takes them by. geniro's request for a closing report is APPENDED to these
   * rather than replacing them, so a task run still honours what the user told
   * every agent.
   */
  customInstructions: CustomInstructionsSchema.optional(),
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
