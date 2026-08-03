import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AgentKindSchema } from '../../runs/runs.types';
import {
  AgentEffortWireSchema,
  AgentMcpListingWireSchema,
  AgentModelWireSchema,
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

/**
 * Query for the MCP-server listing — which agent, and the folder whose servers
 * it would load (validated server-side by `resolveValidCwd`). `refresh` skips
 * the cached health reading; it is what the panel's Refresh control sets, and
 * the only way a server that has since recovered is re-dialled.
 */
export const listMcpServersQuerySchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1),
  refresh: z.stringbool().optional(),
});
export class ListMcpServersQueryDto extends createZodDto(
  listMcpServersQuerySchema,
) {}

/** One agent's MCP servers in a working directory, or why it cannot be asked. */
export class AgentMcpListingDto extends createZodDto(
  AgentMcpListingWireSchema,
) {}

/** Query for the effort listing — which agent CLI's levels to report. */
export const listEffortsQuerySchema = z.object({ agent: AgentKindSchema });
export class ListEffortsQueryDto extends createZodDto(listEffortsQuerySchema) {}

/** One reasoning-effort level an agent CLI accepts for `--effort`. */
export class AgentEffortDto extends createZodDto(AgentEffortWireSchema) {}
