import { Body, Controller, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import { MemoryConfigAckDto, MemoryConfigDto } from '../dto/memory-config.dto';
import type { MemoryConfig } from '../memory.types';
import { MemoryService } from '../services/memory.service';

/**
 * The memory settings. Desktop only, like `PUT /v1/agents/sessions/config`:
 * the value is Electron main's to push from settings.json.
 */
@Controller('v1/memories')
@ApiTags('memories')
@ApiBearerAuth()
@UseGuards(DesktopOnlyGuard)
export class MemoryConfigController {
  constructor(private readonly memory: MemoryService) {}

  @Put('config')
  @ApiOperation({ operationId: 'setMemoryConfig' })
  @ZodResponse({ status: 200, type: MemoryConfigAckDto })
  setConfig(@Body() body: MemoryConfigDto): MemoryConfig {
    return this.memory.setConfig(body);
  }
}
