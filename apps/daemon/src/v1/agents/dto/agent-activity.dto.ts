import { createZodDto } from 'nestjs-zod';

import { AgentActivitySchema } from '../chat.types';

export class AgentActivityDto extends createZodDto(AgentActivitySchema) {}
