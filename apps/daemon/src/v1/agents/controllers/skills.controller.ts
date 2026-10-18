import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type {
  AgentCacheResetWire,
  AgentSessionListingWire,
  AgentSkillWire,
  AgentVocabularyWire,
} from '../chat.types';
import {
  AgentCacheResetDto,
  AgentSessionListingDto,
  AgentSkillDto,
  AgentVocabularyDto,
  ListAgentSessionsQueryDto,
  ListSkillsQueryDto,
  ListVocabularyQueryDto,
} from '../dto/skills.dto';
import { AgentVocabularyService } from '../services/agent-vocabulary.service';
import { CacheResetService } from '../services/cache-reset.service';
import { CliSessionsService } from '../services/cli-sessions.service';
import { SkillsService } from '../services/skills.service';

/**
 * Loopback agent-capability REST surface (token-gated by the global
 * LoopbackTokenGuard): what an agent kind can be invoked with in a folder —
 * the composer's `/` autocomplete listing, and its model vocabulary. The MCP servers it would load are `McpController`'s, which
 * owns them together with the switch that changes them.
 */
@Controller('v1/agents')
@ApiTags('agents')
@ApiBearerAuth()
export class SkillsController {
  constructor(
    private readonly skillsService: SkillsService,
    private readonly vocabularyService: AgentVocabularyService,
    private readonly cliSessionsService: CliSessionsService,
    private readonly cacheResetService: CacheResetService,
  ) {}

  @Get('skills')
  @ApiOperation({ operationId: 'listAgentSkills' })
  @ZodResponse({ status: 200, type: [AgentSkillDto] })
  listSkills(@Query() query: ListSkillsQueryDto): Promise<AgentSkillWire[]> {
    return this.skillsService.list(
      query.agent,
      query.cwd,
      query.configDir ?? null,
    );
  }

  /**
   * The models, and the effort levels, context windows and other parameters of
   * the model named — one answer for a picker that shows all four.
   */
  @Get('vocabulary')
  @ApiOperation({ operationId: 'listAgentVocabulary' })
  @ZodResponse({ status: 200, type: AgentVocabularyDto })
  listVocabulary(
    @Query() query: ListVocabularyQueryDto,
  ): Promise<AgentVocabularyWire> {
    return this.vocabularyService.read(
      query.agent,
      query.model ?? null,
      query.configDir ?? null,
    );
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
