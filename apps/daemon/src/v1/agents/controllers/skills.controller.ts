import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type {
  AgentEffortWire,
  AgentMcpListingWire,
  AgentModelWire,
  AgentSkillWire,
} from '../chat.types';
import {
  AgentEffortDto,
  AgentMcpListingDto,
  AgentModelDto,
  AgentSkillDto,
  ListEffortsQueryDto,
  ListMcpServersQueryDto,
  ListModelsQueryDto,
  ListSkillsQueryDto,
} from '../dto/skills.dto';
import { EffortsService } from '../services/efforts.service';
import { McpService } from '../services/mcp.service';
import { ModelsService } from '../services/models.service';
import { SkillsService } from '../services/skills.service';

/**
 * Loopback agent-capability REST surface (token-gated by the global
 * LoopbackTokenGuard): what an agent kind can be invoked with in a folder —
 * the composer's `/` autocomplete listing, its model and effort vocabularies,
 * and the MCP servers it would load there.
 */
@Controller('v1/agents')
@ApiTags('agents')
@ApiBearerAuth()
export class SkillsController {
  constructor(
    private readonly skillsService: SkillsService,
    private readonly modelsService: ModelsService,
    private readonly effortsService: EffortsService,
    private readonly mcpService: McpService,
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

  @Get('efforts')
  @ApiOperation({ operationId: 'listAgentEfforts' })
  @ZodResponse({ status: 200, type: [AgentEffortDto] })
  listEfforts(@Query() query: ListEffortsQueryDto): AgentEffortWire[] {
    return this.effortsService.list(query.agent);
  }

  @Get('mcp')
  @ApiOperation({ operationId: 'listAgentMcpServers' })
  @ZodResponse({ status: 200, type: AgentMcpListingDto })
  listMcpServers(
    @Query() query: ListMcpServersQueryDto,
  ): Promise<AgentMcpListingWire> {
    return this.mcpService.list(query.agent, query.cwd, query.refresh ?? false);
  }
}
