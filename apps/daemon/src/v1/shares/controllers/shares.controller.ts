import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import {
  CreateShareDto,
  ProbeShareDestinationDto,
  RevokeAllSharesDto,
  RevokeShareDto,
  RevokeSharesDto,
  ShareConfigAckDto,
  ShareConfigDto,
  ShareCreatedDto,
  ShareLinkDto,
  ShareListDto,
  ShareListQueryDto,
  ShareProbeResultDto,
} from '../dto/shares.dto';
import { ShareService } from '../services/share.service';
import type { RevokeManyOutcome, RevokeOutcome, Share } from '../shares.types';

/**
 * Encrypted share links for artifacts. Desktop only: every route acts with the
 * Mac user's own CLI logins and Keychain, so none is reachable from a paired
 * device.
 */
@Controller('v1/shares')
@ApiTags('shares')
@ApiBearerAuth()
@UseGuards(DesktopOnlyGuard)
export class SharesController {
  constructor(private readonly shares: ShareService) {}

  @Put('config')
  @ApiOperation({ operationId: 'setShareConfig' })
  @ZodResponse({ status: 200, type: ShareConfigAckDto })
  setConfig(@Body() body: ShareConfigDto): { receivedAt: string } {
    return this.shares.setConfig(body);
  }

  @Post('probe')
  @ApiOperation({ operationId: 'probeShareDestination' })
  @ZodResponse({ status: 201, type: ShareProbeResultDto })
  probe(
    @Body() body: ProbeShareDestinationDto,
  ): Promise<{ ok: boolean; detail: string }> {
    return this.shares.probe(body.destination);
  }

  @Get()
  @ApiOperation({ operationId: 'listShares' })
  @ZodResponse({ status: 200, type: ShareListDto })
  async list(
    @Query() query: ShareListQueryDto,
  ): Promise<{ shares: Share[]; configReceivedAt: string | null }> {
    return {
      shares: await this.shares.list(query.runId),
      configReceivedAt: this.shares.receivedAt,
    };
  }

  @Post()
  @ApiOperation({ operationId: 'shareArtifact' })
  @ZodResponse({ status: 201, type: ShareCreatedDto })
  share(@Body() body: CreateShareDto): Promise<{ share: Share; url: string }> {
    return this.shares.share({ ...body, by: 'user' });
  }

  @Post('revoke-all')
  @ApiOperation({ operationId: 'revokeAllShares' })
  @ZodResponse({ status: 201, type: RevokeAllSharesDto })
  revokeAll(@Body() body: RevokeSharesDto): Promise<RevokeManyOutcome> {
    return this.shares.revokeAll(body.shareIds);
  }

  @Get(':shareId/link')
  @ApiOperation({ operationId: 'readShareLink' })
  @ZodResponse({ status: 200, type: ShareLinkDto })
  link(@Param('shareId') shareId: string): Promise<{ url: string }> {
    return this.shares.link(shareId);
  }

  @Delete(':shareId')
  @ApiOperation({ operationId: 'revokeShare' })
  @ZodResponse({ status: 200, type: RevokeShareDto })
  revoke(@Param('shareId') shareId: string): Promise<RevokeOutcome> {
    return this.shares.revoke(shareId);
  }
}
