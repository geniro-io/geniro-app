import { Body, Controller, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import {
  KeptSessionConfigAckDto,
  KeptSessionConfigDto,
} from '../dto/kept-sessions.dto';
import { AgentSessionRegistry } from '../services/agent-session.registry';

/**
 * The CLI processes runs keep between turns. Desktop only, like
 * `PUT /v1/shares/config`: the value is Electron main's to push from
 * settings.json, and a paired device may not change it.
 */
@Controller('v1/agents/sessions')
@ApiTags('agents')
@ApiBearerAuth()
@UseGuards(DesktopOnlyGuard)
export class KeptSessionsController {
  constructor(private readonly sessions: AgentSessionRegistry) {}

  @Put('config')
  @ApiOperation({ operationId: 'setKeptSessionConfig' })
  @ZodResponse({ status: 200, type: KeptSessionConfigAckDto })
  setConfig(@Body() body: KeptSessionConfigDto): { idleMinutes: number } {
    this.sessions.setIdleMinutes(body.idleMinutes);
    return { idleMinutes: this.sessions.idleMinutes };
  }
}
