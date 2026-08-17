import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type { LoginSession, LogoutResult } from '../auth.types';
import {
  CliAuthQueryDto,
  LoginCodeBodyDto,
  LoginSessionDto,
  LogoutResultDto,
  McpLoginQueryDto,
} from '../dto/cli-auth.dto';
import { CliAuthService } from '../services/cli-auth.service';

/**
 * Signing a CLI in and out WITHOUT a terminal window (token-gated by the global
 * LoopbackTokenGuard).
 *
 * Separate from `/v1/handoff`, which stays resolve-only and is still the fallback
 * — that surface answers "what would I type", this one runs it. Keeping them apart
 * is what lets the resolve-only promise on the handoff routes remain literally
 * true, rather than becoming "resolve-only except sometimes".
 *
 * POST, not GET, and unlike every handoff route: these change machine state.
 */
@Controller('v1/auth')
@ApiTags('cliAuth')
@ApiBearerAuth()
export class CliAuthController {
  constructor(private readonly auth: CliAuthService) {}

  @Post('logout')
  @ApiOperation({ operationId: 'cliLogout' })
  @ZodResponse({ status: 200, type: LogoutResultDto })
  logout(@Query() query: CliAuthQueryDto): Promise<LogoutResult> {
    return this.auth.logout(query);
  }

  @Post('login')
  @ApiOperation({ operationId: 'startCliLogin' })
  @ZodResponse({ status: 200, type: LoginSessionDto })
  startLogin(@Query() query: CliAuthQueryDto): Promise<LoginSession> {
    return this.auth.startLogin(query);
  }

  /**
   * Sign in to one MCP server, here, without a terminal window.
   *
   * Its state is read and cancelled through the SAME `login/:id` routes below:
   * one session shape, one map, one lifecycle — a parallel set would be two
   * places for a cancel to be got wrong.
   */
  @Post('mcp-login')
  @ApiOperation({ operationId: 'startMcpLogin' })
  @ZodResponse({ status: 200, type: LoginSessionDto })
  startMcpLogin(@Query() query: McpLoginQueryDto): Promise<LoginSession> {
    return this.auth.startMcpLogin(query);
  }

  @Get('login/:id')
  @ApiOperation({ operationId: 'getCliLogin' })
  @ZodResponse({ status: 200, type: LoginSessionDto })
  getLogin(@Param('id') id: string): LoginSession {
    return this.auth.status(id);
  }

  @Post('login/:id/code')
  @ApiOperation({ operationId: 'submitCliLoginCode' })
  @ZodResponse({ status: 200, type: LoginSessionDto })
  submitCode(
    @Param('id') id: string,
    @Body() body: LoginCodeBodyDto,
  ): LoginSession {
    return this.auth.submitCode(id, body.code);
  }

  @Post('login/:id/cancel')
  @ApiOperation({ operationId: 'cancelCliLogin' })
  @ZodResponse({ status: 200, type: LoginSessionDto })
  cancel(@Param('id') id: string): LoginSession {
    return this.auth.cancelLogin(id);
  }
}
