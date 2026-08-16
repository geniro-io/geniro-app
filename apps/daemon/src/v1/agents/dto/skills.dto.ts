import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AgentKindSchema } from '../../runs/runs.types';
import {
  AgentEffortWireSchema,
  AgentModelWireSchema,
  AgentSessionListingWireSchema,
  AgentSkillWireSchema,
} from '../chat.types';

/**
 * Query for the skills listing — which agent's on-disk skill convention to
 * scan, and the project folder to scan it in (validated server-side by
 * `resolveValidCwd`: must exist and be a directory).
 */
export const listSkillsQuerySchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1),
});
export class ListSkillsQueryDto extends createZodDto(listSkillsQuerySchema) {}

/** One skill / slash command an agent accepts in a working directory. */
export class AgentSkillDto extends createZodDto(AgentSkillWireSchema) {}

/** Query for the model listing — which agent CLI to ask. */
export const listModelsQuerySchema = z.object({ agent: AgentKindSchema });
export class ListModelsQueryDto extends createZodDto(listModelsQuerySchema) {}

/** One model an agent CLI accepts for `--model`. */
export class AgentModelDto extends createZodDto(AgentModelWireSchema) {}

/** Query for the effort listing — which agent CLI's levels to report. */
export const listEffortsQuerySchema = z.object({ agent: AgentKindSchema });
export class ListEffortsQueryDto extends createZodDto(listEffortsQuerySchema) {}

/** One reasoning-effort level an agent CLI accepts for `--effort`. */
export class AgentEffortDto extends createZodDto(AgentEffortWireSchema) {}

/**
 * Query for the sessions listing: which CLI to ask, optionally narrowed to one
 * folder and one profile.
 *
 * `cwd` is optional here where the skills listing requires it, and that is the
 * feature rather than an inconsistency: "everything I have ever worked on" is a
 * real question for a picker whose whole job is finding an old conversation,
 * while a skill listing only means anything relative to a folder.
 */
export const listAgentSessionsQuerySchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1).optional(),
  configDir: z.string().min(1).optional(),
});
export class ListAgentSessionsQueryDto extends createZodDto(
  listAgentSessionsQuerySchema,
) {}

/** The conversations one CLI holds, and why the list may not be everything. */
export class AgentSessionListingDto extends createZodDto(
  AgentSessionListingWireSchema,
) {}
