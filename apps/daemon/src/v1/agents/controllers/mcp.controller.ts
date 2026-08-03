import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type { AgentMcpListingWire } from '../chat.types';
import {
  AgentMcpListingDto,
  ListMcpServersQueryDto,
  SetMcpServerEnabledDto,
} from '../dto/mcp.dto';
import { AgentMcpService } from '../services/agent-mcp.service';

/**
 * The MCP servers one agent loads in one folder, and the switch that decides
 * which of them it loads next turn (token-gated by the global
 * LoopbackTokenGuard).
 *
 * Its own controller rather than a corner of the skills surface: this is the
 * one agent-capability resource with a WRITE path, and a route that changes
 * what the next turn runs does not belong in a file named for autocomplete.
 */
@Controller('v1/agents/mcp')
@ApiTags('agents')
@ApiBearerAuth()
export class McpController {
  constructor(private readonly mcpService: AgentMcpService) {}

  @Get()
  @ApiOperation({ operationId: 'listAgentMcpServers' })
  @ZodResponse({ status: 200, type: AgentMcpListingDto })
  listMcpServers(
    @Query() query: ListMcpServersQueryDto,
  ): Promise<AgentMcpListingWire> {
    return this.mcpService.list(query.agent, query.cwd ?? null, {
      pluginDir: query.pluginDir ?? null,
      refresh: query.refresh ?? false,
    });
  }

  @Put()
  @ApiOperation({ operationId: 'setAgentMcpServerEnabled' })
  @ZodResponse({ status: 200, type: AgentMcpListingDto })
  setEnabled(
    @Body() body: SetMcpServerEnabledDto,
  ): Promise<AgentMcpListingWire> {
    return this.mcpService.setEnabled(
      body.agent,
      body.cwd,
      body.server,
      body.enabled,
    );
  }
}
