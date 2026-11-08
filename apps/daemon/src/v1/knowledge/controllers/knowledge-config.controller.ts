import { Body, Controller, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import {
  KnowledgeConfigAckDto,
  KnowledgeConfigDto,
} from '../dto/knowledge-config.dto';
import type { KnowledgeConfig } from '../knowledge.types';
import { KnowledgeService } from '../services/knowledge.service';

/**
 * The knowledge settings. Desktop only, like memory's: the value is Electron
 * main's to push from settings.json.
 */
@Controller('v1/knowledge')
@ApiTags('knowledge')
@ApiBearerAuth()
@UseGuards(DesktopOnlyGuard)
export class KnowledgeConfigController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Put('config')
  @ApiOperation({ operationId: 'setKnowledgeConfig' })
  @ZodResponse({ status: 200, type: KnowledgeConfigAckDto })
  setConfig(@Body() body: KnowledgeConfigDto): KnowledgeConfig {
    return this.knowledge.setConfig(body);
  }
}
