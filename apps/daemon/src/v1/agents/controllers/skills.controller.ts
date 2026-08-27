import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type {
  AgentCacheResetWire,
  AgentContextWindowListingWire,
  AgentEffortListingWire,
  AgentModelParameterListingWire,
  AgentModelWire,
  AgentSessionListingWire,
  AgentSkillWire,
} from '../chat.types';
import {
  AgentCacheResetDto,
  AgentContextWindowListingDto,
  AgentEffortListingDto,
  AgentModelDto,
  AgentModelParameterListingDto,
  AgentSessionListingDto,
  AgentSkillDto,
  ListAgentSessionsQueryDto,
  ListContextWindowsQueryDto,
  ListEffortsQueryDto,
  ListModelParametersQueryDto,
  ListModelsQueryDto,
  ListSkillsQueryDto,
} from '../dto/skills.dto';
import { CacheResetService } from '../services/cache-reset.service';
import { CliSessionsService } from '../services/cli-sessions.service';
import { ContextWindowsService } from '../services/context-windows.service';
import { EffortsService } from '../services/efforts.service';
import { ModelParametersService } from '../services/model-parameters.service';
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
    private readonly contextWindowsService: ContextWindowsService,
    private readonly modelParametersService: ModelParametersService,
    private readonly cliSessionsService: CliSessionsService,
    private readonly cacheResetService: CacheResetService,
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
      query.query ?? null,
    );
  }

  /**
   * The effort levels available for one CLI, narrowed to one MODEL when the
   * caller names one — see {@link ListEffortsQueryDto}.
   */
  @Get('efforts')
  @ApiOperation({ operationId: 'listAgentEfforts' })
  @ZodResponse({ status: 200, type: AgentEffortListingDto })
  listEfforts(
    @Query() query: ListEffortsQueryDto,
  ): Promise<AgentEffortListingWire> {
    return this.effortsService.list(query.agent, query.model ?? null);
  }

  /**
   * The context-window sizes one MODEL of a CLI can be run at — reported by
   * the CLI itself, never from a table here (see
   * `AgentContextWindowListingWireSchema`).
   */
  @Get('context-windows')
  @ApiOperation({ operationId: 'listAgentContextWindows' })
  @ZodResponse({ status: 200, type: AgentContextWindowListingDto })
  listContextWindows(
    @Query() query: ListContextWindowsQueryDto,
  ): Promise<AgentContextWindowListingWire> {
    return this.contextWindowsService.listWire(
      query.agent,
      query.model ?? null,
    );
  }

  /**
   * Every OTHER setting one MODEL offers — whatever the CLI enumerates beyond
   * the model, its effort and its context window, each of which already has a
   * control of its own. See `AgentModelParameter`.
   */
  @Get('model-parameters')
  @ApiOperation({ operationId: 'listAgentModelParameters' })
  @ZodResponse({ status: 200, type: AgentModelParameterListingDto })
  listModelParameters(
    @Query() query: ListModelParametersQueryDto,
  ): Promise<AgentModelParameterListingWire> {
    return this.modelParametersService.listWire(
      query.agent,
      query.model ?? null,
    );
  }

  /**
   * Forget every cached answer above, on the user's own instruction — the menu
   * bar's Clear Agent Cache. A POST because it CHANGES what the daemon holds;
   * see `CacheResetService` for what is cleared and what deliberately is not.
   */
  @Post('caches/clear')
  @ApiOperation({ operationId: 'clearAgentCaches' })
  @ZodResponse({ status: 200, type: AgentCacheResetDto })
  clearCaches(): AgentCacheResetWire {
    return this.cacheResetService.clearAll();
  }
}
