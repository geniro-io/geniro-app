import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type {
  AgentEffortWire,
  AgentModelWire,
  AgentSessionListingWire,
  AgentSkillWire,
} from '../chat.types';
import {
  AgentEffortDto,
  AgentModelDto,
  AgentSessionListingDto,
  AgentSkillDto,
  ListAgentSessionsQueryDto,
  ListEffortsQueryDto,
  ListModelsQueryDto,
  ListSkillsQueryDto,
} from '../dto/skills.dto';
import { CliSessionsService } from '../services/cli-sessions.service';
import { EffortsService } from '../services/efforts.service';
import { ModelsService } from '../services/models.service';
import { SkillsService } from '../services/skills.service';

/**
 * Loopback agent-capability REST surface (token-gated by the global
 * LoopbackTokenGuard): what an agent kind can be invoked with in a folder —
 * the composer's `/` autocomplete listing, and its model and effort
 * vocabularies. The MCP servers it would load are `McpController`'s, which
 * owns them together with the switch that changes them.
 */
@Controller('v1/agents')
@ApiTags('agents')
@ApiBearerAuth()
export class SkillsController {
  constructor(
    private readonly skillsService: SkillsService,
    private readonly modelsService: ModelsService,
    private readonly effortsService: EffortsService,
    private readonly cliSessionsService: CliSessionsService,
  ) {}

  @Get('skills')
  @ApiOperation({ operationId: 'listAgentSkills' })
  @ZodResponse({ status: 200, type: [AgentSkillDto] })
  listSkills(@Query() query: ListSkillsQueryDto): Promise<AgentSkillWire[]> {
    return this.skillsService.list(query.agent, query.cwd);
  }

  @Get('models')
  @ApiOperation({ operationId: 'listAgentModels' })
  @ZodResponse({ status: 200, type: [AgentModelDto] })
  listModels(@Query() query: ListModelsQueryDto): Promise<AgentModelWire[]> {
    return this.modelsService.list(query.agent);
  }

  /**
   * The conversations this CLI already holds on the machine — what a new thread
   * can be started FROM rather than started blank.
   */
  @Get('sessions')
  @ApiOperation({ operationId: 'listAgentSessions' })
  @ZodResponse({ status: 200, type: AgentSessionListingDto })
  listSessions(
    @Query() query: ListAgentSessionsQueryDto,
  ): Promise<AgentSessionListingWire> {
    return this.cliSessionsService.list(
      query.agent,
      query.cwd ?? null,
      query.configDir ?? null,
    );
  }

  @Get('efforts')
  @ApiOperation({ operationId: 'listAgentEfforts' })
  @ZodResponse({ status: 200, type: [AgentEffortDto] })
  listEfforts(@Query() query: ListEffortsQueryDto): AgentEffortWire[] {
    return this.effortsService.list(query.agent);
  }
}
