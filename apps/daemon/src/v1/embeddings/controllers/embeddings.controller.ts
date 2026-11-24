import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import {
  EmbeddingConfigAckDto,
  EmbeddingConfigDto,
  EmbeddingStatusDto,
} from '../dto/embeddings.dto';
import type { EmbeddingConfig, EmbeddingStatus } from '../embeddings.types';
import { EmbeddingIndexService } from '../services/embedding-index.service';

/**
 * Search by meaning. The config is Electron main's to push from settings.json;
 * the status is read by Settings → Search.
 */
@Controller('v1/embeddings')
@ApiTags('embeddings')
@ApiBearerAuth()
export class EmbeddingsController {
  constructor(private readonly index: EmbeddingIndexService) {}

  @Put('config')
  @UseGuards(DesktopOnlyGuard)
  @ApiOperation({ operationId: 'setEmbeddingConfig' })
  @ZodResponse({ status: 200, type: EmbeddingConfigAckDto })
  setConfig(@Body() body: EmbeddingConfigDto): Promise<EmbeddingConfig> {
    return this.index.setConfig(body);
  }

  @Get('status')
  @ApiOperation({ operationId: 'getEmbeddingStatus' })
  @ZodResponse({ status: 200, type: EmbeddingStatusDto })
  status(): Promise<EmbeddingStatus> {
    return this.index.status();
  }

  @Delete('index')
  @UseGuards(DesktopOnlyGuard)
  @HttpCode(204)
  @ApiOperation({ operationId: 'deleteEmbeddingIndex' })
  async clear(): Promise<void> {
    await this.index.clear();
  }
}
