import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AgentKindSchema } from '../../runs/runs.types';
import { AgentModelWireSchema, AgentSkillWireSchema } from '../chat.types';

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
