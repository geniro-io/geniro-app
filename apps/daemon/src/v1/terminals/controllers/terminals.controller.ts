import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import {
  CreateTerminalDto,
  DisposedDto,
  TerminalSessionDto,
} from '../dto/terminal.dto';
import { PtyService } from '../services/pty.service';
import { TerminalsService } from '../services/terminals.service';
import type { TerminalSessionWire } from '../terminals.types';

/**
 * Loopback terminal-mirror REST surface (token-gated by the global
 * LoopbackTokenGuard). Session lifecycle is HTTP; the byte plane (attach,
 * input, resize, detach) rides the `/terminals` Socket.IO namespace.
 */
@Controller('v1/terminals')
@ApiTags('terminals')
@ApiBearerAuth()
export class TerminalsController {
  constructor(
    private readonly terminals: TerminalsService,
    private readonly pty: PtyService,
  ) {}

  @Post()
  @ApiOperation({ operationId: 'createTerminal' })
  @ZodResponse({ status: 201, type: TerminalSessionDto })
  createTerminal(@Body() dto: CreateTerminalDto): Promise<TerminalSessionWire> {
    return this.terminals.createForRun(dto);
  }

  @Get()
  @ApiOperation({ operationId: 'listTerminals' })
  @ZodResponse({ status: 200, type: [TerminalSessionDto] })
  listTerminals(): TerminalSessionWire[] {
    return this.pty.list();
  }

  @Get(':id')
  @ApiOperation({ operationId: 'getTerminal' })
  @ZodResponse({ status: 200, type: TerminalSessionDto })
  getTerminal(@Param('id') id: string): TerminalSessionWire {
    return this.pty.get(id);
  }

  @Delete(':id')
  @ApiOperation({ operationId: 'disposeTerminal' })
  @ZodResponse({ status: 200, type: DisposedDto })
  disposeTerminal(@Param('id') id: string): { disposed: boolean } {
    this.pty.dispose(id);
    return { disposed: true };
  }
}
