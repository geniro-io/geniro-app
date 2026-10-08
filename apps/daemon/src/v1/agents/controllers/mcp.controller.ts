import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type { AgentMcpConfigWire, AgentMcpListingWire } from '../chat.types';
import {
  AddMcpServerDto,
  AgentMcpConfigDto,
  AgentMcpListingDto,
  CopyPluginMcpServerDto,
  ListMcpServersQueryDto,
  ReadMcpConfigQueryDto,
  RecheckMcpServerDto,
  SetMcpServerEnabledDto,
  WriteMcpConfigDto,
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
      { configDir: body.configDir ?? null },
    );
  }

  /**
   * Copy a plugin's MCP server into the CLI's own config, so the turns geniro
   * runs load it, and answer with the listing that results.
   */
  @Post('plugin-servers')
  @ApiOperation({ operationId: 'copyAgentMcpPluginServer' })
  @ZodResponse({ status: 200, type: AgentMcpListingDto })
  copyPluginServer(
    @Body() body: CopyPluginMcpServerDto,
  ): Promise<AgentMcpListingWire> {
    return this.mcpService.copyPluginServer(body);
  }

  /**
   * The profile's user-scope MCP document — what the "Edit JSON" editor opens.
   */
  @Get('config')
  @ApiOperation({ operationId: 'readAgentMcpConfig' })
  @ZodResponse({ status: 200, type: AgentMcpConfigDto })
  readConfig(
    @Query() query: ReadMcpConfigQueryDto,
  ): Promise<AgentMcpConfigWire> {
    return this.mcpService.readConfig(query.agent, query.configDir ?? null);
  }

  /**
   * Save the JSON editor: replace the profile's whole user-scope server map,
   * and answer with the document as it now reads.
   */
  @Put('config')
  @ApiOperation({ operationId: 'writeAgentMcpConfig' })
  @ZodResponse({ status: 200, type: AgentMcpConfigDto })
  writeConfig(@Body() body: WriteMcpConfigDto): Promise<AgentMcpConfigWire> {
    return this.mcpService.writeConfig({
      agent: body.agent,
      configDir: body.configDir ?? null,
      servers: body.servers,
      version: body.version,
    });
  }

  /**
   * Add one server through the CLI's own mechanism, and answer with the
   * profile's document.
   */
  @Post('servers')
  @ApiOperation({ operationId: 'addAgentMcpServer' })
  @ZodResponse({ status: 200, type: AgentMcpConfigDto })
  addServer(@Body() body: AddMcpServerDto): Promise<AgentMcpConfigWire> {
    return this.mcpService.addServer({
      agent: body.agent,
      configDir: body.configDir ?? null,
      server: {
        name: body.name,
        transport: body.transport,
        command: body.command ?? null,
        args: body.args,
        env: body.env,
        url: body.url ?? null,
        headers: body.headers,
      },
    });
  }
}
