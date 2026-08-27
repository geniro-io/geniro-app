import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type { AgentMcpListingWire } from '../chat.types';
import {
  AgentMcpListingDto,
  ListMcpServersQueryDto,
  RecheckMcpServerDto,
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
      configDir: query.configDir ?? null,
      refresh: query.refresh ?? false,
    });
  }

  /**
   * Re-dial ONE server. The narrow counterpart to `?refresh=true`, which
   * re-dials the whole folder — see {@link AgentMcpService.recheckServer} for
   * the price difference and the sign-in flow that needs it.
   */
  @Post('recheck')
  @ApiOperation({ operationId: 'recheckAgentMcpServer' })
  @ZodResponse({ status: 200, type: AgentMcpListingDto })
  recheckServer(
    @Body() body: RecheckMcpServerDto,
  ): Promise<AgentMcpListingWire> {
    return this.mcpService.recheckServer(body.agent, body.cwd, body.server, {
      configDir: body.configDir ?? null,
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
