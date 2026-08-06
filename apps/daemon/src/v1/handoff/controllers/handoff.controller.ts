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
