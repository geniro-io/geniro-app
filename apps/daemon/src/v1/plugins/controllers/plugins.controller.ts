import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import {
  PluginApproveRequestDto,
  PluginBlockListDto,
  PluginDetailDto,
  PluginListDto,
  PluginPatchRequestDto,
  PluginPressRequestDto,
  PluginPressResultDto,
  PluginRemovedDto,
  PluginRunRequestDto,
  PluginRunResultDto,
  PluginSummaryDto,
} from '../dto/plugins.dto';
import type {
  PluginBlockList,
  PluginDetail,
  PluginList,
  PluginPressResult,
  PluginRunResult,
  PluginSummary,
} from '../plugins.types';
import { PluginsService } from '../services/plugins.service';

/**
 * The user's plugins: list, read, approve, switch, re-folder, delete, and run
 * in a thread's folder. Open to paired devices on every route — the user
 * decided a phone or tablet may do all of it, approving a command included.
 */
@Controller('v1/plugins')
@ApiTags('plugins')
@ApiBearerAuth()
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}

  @Get()
  @ApiOperation({ operationId: 'listPlugins' })
  @ZodResponse({ status: 200, type: PluginListDto })
  list(): Promise<PluginList> {
    return this.plugins.list();
  }

  @Get('for-run/:runId')
  @ApiOperation({ operationId: 'listPluginBlocksForRun' })
  @ZodResponse({ status: 200, type: PluginBlockListDto })
  forRun(@Param('runId') runId: string): Promise<PluginBlockList> {
    return this.plugins.blocksForRun(runId);
  }

  @Get(':slug')
  @ApiOperation({ operationId: 'readPlugin' })
  @ZodResponse({ status: 200, type: PluginDetailDto })
  detail(@Param('slug') slug: string): Promise<PluginDetail> {
    return this.plugins.detail(slug);
  }

  @Post(':slug/run')
  @HttpCode(200)
  @ApiOperation({ operationId: 'runPlugin' })
  @ZodResponse({ status: 200, type: PluginRunResultDto })
  run(
    @Param('slug') slug: string,
    @Body() body: PluginRunRequestDto,
  ): Promise<PluginRunResult> {
    return this.plugins.run(slug, body.runId, body.force ?? false);
  }

  @Post(':slug/buttons/:buttonId/press')
  @HttpCode(200)
  @ApiOperation({ operationId: 'pressPluginButton' })
  @ZodResponse({ status: 200, type: PluginPressResultDto })
  press(
    @Param('slug') slug: string,
    @Param('buttonId') buttonId: string,
    @Body() body: PluginPressRequestDto,
  ): Promise<PluginPressResult> {
    return this.plugins.press(slug, buttonId, body.runId, body.dataAt);
  }

  @Post(':slug/approve')
  @HttpCode(200)
  @ApiOperation({ operationId: 'approvePlugin' })
  @ZodResponse({ status: 200, type: PluginSummaryDto })
  approve(
    @Param('slug') slug: string,
    @Body() body: PluginApproveRequestDto,
  ): Promise<PluginSummary> {
    return this.plugins.approve(slug, body.hash);
  }

  @Patch(':slug')
  @ApiOperation({ operationId: 'updatePlugin' })
  @ZodResponse({ status: 200, type: PluginSummaryDto })
  patch(
    @Param('slug') slug: string,
    @Body() body: PluginPatchRequestDto,
  ): Promise<PluginSummary> {
    return this.plugins.patch(slug, body);
  }

  @Delete(':slug')
  @ApiOperation({ operationId: 'deletePlugin' })
  @ZodResponse({ status: 200, type: PluginRemovedDto })
  async remove(@Param('slug') slug: string): Promise<{ removed: boolean }> {
    return { removed: await this.plugins.delete(slug) };
  }
}
