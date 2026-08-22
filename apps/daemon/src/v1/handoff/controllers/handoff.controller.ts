import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { HandoffQueryDto, HandoffTargetDto } from '../dto/handoff.dto';
import type { HandoffTarget } from '../handoff.types';
import { HandoffService } from '../services/handoff.service';

/**
 * Loopback handoff surface (token-gated by the global LoopbackTokenGuard):
 * "how do I open this conversation in the CLI myself".
 *
 * A GET with no side effects, because that is all this is now — the daemon
 * answers with a command and the Electron main process is what opens a
 * terminal with it. There is no session to create, nothing to tear down, and
 * no byte plane: the PTY mirror and its `/terminals` namespace are gone.
 *
 * ONE route, and it is the only thing on this surface a terminal is still FOR.
 * Three siblings resolved a sign-in — the CLI's own account, its sign-out, and
 * one MCP server — on the reasoning that an interactive browser flow wants a
 * TTY the daemon cannot be. Re-probed, that turned out to be true of the
 * TERMINAL and not of being watched: `v1/auth` allocates the pty itself and
 * runs all three, so every caller moved there and these were left resolving
 * commands nobody asked for.
 */
@Controller('v1/handoff')
@ApiTags('handoff')
@ApiBearerAuth()
export class HandoffController {
  constructor(private readonly handoff: HandoffService) {}

  @Get()
  @ApiOperation({ operationId: 'resolveHandoff' })
  @ZodResponse({ status: 200, type: HandoffTargetDto })
  resolve(@Query() query: HandoffQueryDto): Promise<HandoffTarget> {
    return this.handoff.resolve(query);
  }
}
