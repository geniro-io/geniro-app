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
  CheckShareDestinationDto,
  CreateShareDto,
  RevokeShareDto,
  ShareCheckResultDto,
  ShareConfigAckDto,
  ShareConfigDto,
  ShareCreatedDto,
  ShareLinkDto,
  ShareListDto,
  ShareListQueryDto,
  ShareSignInSessionDto,
  StartShareSignInDto,
} from '../dto/shares.dto';
import { ShareService } from '../services/share.service';
import { ShareSignInService } from '../services/share-sign-in.service';
import type {
  RevokeOutcome,
  Share,
  ShareCheckResult,
  ShareSignInSession,
} from '../shares.types';

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
  constructor(
    private readonly shares: ShareService,
    private readonly signIns: ShareSignInService,
  ) {}

  @Put('config')
  @ApiOperation({ operationId: 'setShareConfig' })
  @ZodResponse({ status: 200, type: ShareConfigAckDto })
  setConfig(@Body() body: ShareConfigDto): { receivedAt: string } {
    return this.shares.setConfig(body);
  }

  @Post('check')
  @ApiOperation({ operationId: 'checkShareDestination' })
  @ZodResponse({ status: 201, type: ShareCheckResultDto })
  check(@Body() body: CheckShareDestinationDto): Promise<ShareCheckResult> {
    return this.shares.check(body.destination);
  }

  @Post('sign-in')
  @ApiOperation({ operationId: 'startShareSignIn' })
  @ZodResponse({ status: 201, type: ShareSignInSessionDto })
  startSignIn(@Body() body: StartShareSignInDto): Promise<ShareSignInSession> {
    return this.signIns.start(body.destinationId);
  }

  @Get('sign-in/:signInId')
  @ApiOperation({ operationId: 'readShareSignIn' })
  @ZodResponse({ status: 200, type: ShareSignInSessionDto })
  signInStatus(@Param('signInId') signInId: string): ShareSignInSession {
    return this.signIns.status(signInId);
  }

  @Delete('sign-in/:signInId')
  @ApiOperation({ operationId: 'cancelShareSignIn' })
  @ZodResponse({ status: 200, type: ShareSignInSessionDto })
  cancelSignIn(@Param('signInId') signInId: string): ShareSignInSession {
    return this.signIns.cancel(signInId);
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
  share(
    @Body() body: CreateShareDto,
  ): Promise<{ share: Share; url: string | null }> {
    return this.shares.share({ ...body, by: 'user' });
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
