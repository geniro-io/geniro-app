import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';

import { CreateTerminalDto } from '../dto/terminal.dto';
import { PtyService } from '../services/pty.service';
import { TerminalsService } from '../services/terminals.service';
import type { TerminalSessionWire } from '../terminals.types';

/**
 * Loopback terminal-mirror REST surface (token-gated by the global
 * LoopbackTokenGuard). Session lifecycle is HTTP; the byte plane (attach,
 * input, resize, detach) rides the `/terminals` Socket.IO namespace.
 */
@Controller('v1/terminals')
export class TerminalsController {
  constructor(
    private readonly terminals: TerminalsService,
    private readonly pty: PtyService,
  ) {}

  @Post()
  createTerminal(@Body() dto: CreateTerminalDto): Promise<TerminalSessionWire> {
    return this.terminals.createForRun(dto);
  }

  @Get()
  listTerminals(): TerminalSessionWire[] {
    return this.pty.list();
  }

  @Get(':id')
  getTerminal(@Param('id') id: string): TerminalSessionWire {
    return this.pty.get(id);
  }

  @Delete(':id')
  disposeTerminal(@Param('id') id: string): { disposed: boolean } {
    this.pty.dispose(id);
    return { disposed: true };
  }
}
