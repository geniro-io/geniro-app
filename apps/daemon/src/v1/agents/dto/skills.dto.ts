import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Query for the skills listing — which agent's on-disk skill convention to
 * scan, and the project folder to scan it in (validated server-side by
 * `resolveValidCwd`: must exist and be a directory).
 */
export const listSkillsQuerySchema = z.object({
  agent: z.enum(['claude', 'cursor-agent']),
  cwd: z.string().min(1),
});
export class ListSkillsQueryDto extends createZodDto(listSkillsQuerySchema) {}
