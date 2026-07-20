import { Controller, Get, Query } from '@nestjs/common';

import type { AgentSkillWire } from '../chat.types';
import { ListSkillsQueryDto } from '../dto/skills.dto';
import { SkillsService } from '../services/skills.service';

/**
 * Loopback agent-capability REST surface (token-gated by the global
 * LoopbackTokenGuard): what an agent kind can be invoked with in a folder —
 * today just the composer's `/` autocomplete listing.
 */
@Controller('v1/agents')
export class SkillsController {
  constructor(private readonly skillsService: SkillsService) {}

  @Get('skills')
  listSkills(@Query() query: ListSkillsQueryDto): Promise<AgentSkillWire[]> {
    return this.skillsService.list(query.agent, query.cwd);
  }
}
