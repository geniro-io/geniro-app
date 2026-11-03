import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import type { AgentActivity } from '../chat.types';
import { AgentActivityDto } from '../dto/agent-activity.dto';
import { AgentActivityService } from '../services/agent-activity.service';

/**
 * Read by Electron main, which keeps the Mac from idle sleep while it answers
 * `working` (`Settings.preventSleepWhileWorking`).
 */
@Controller('v1/agents/activity')
@ApiTags('agents')
@ApiBearerAuth()
@UseGuards(DesktopOnlyGuard)
export class AgentActivityController {
  constructor(private readonly activity: AgentActivityService) {}

  @Get()
  @ApiOperation({ operationId: 'getAgentActivity' })
  @ZodResponse({ status: 200, type: AgentActivityDto })
  read(): AgentActivity {
    return { working: this.activity.working };
  }
}
