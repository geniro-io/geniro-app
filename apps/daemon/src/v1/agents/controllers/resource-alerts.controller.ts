import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import type {
  ResourceAlertConfig,
  ResourceAlertsWire,
  StoppedResourceAlertCommand,
} from '../chat.types';
import {
  ResourceAlertConfigAckDto,
  ResourceAlertConfigDto,
  ResourceAlertsDto,
  StoppedResourceAlertCommandDto,
} from '../dto/resource-alerts.dto';
import { ResourceWatchService } from '../services/resource-watch.service';

/**
 * The resource watch's alerts. The config is desktop only, like
 * `PUT /v1/agents/sessions/config`: Electron main pushes it from settings.json.
 */
@Controller('v1/resource-alerts')
@ApiTags('chats')
@ApiBearerAuth()
export class ResourceAlertsController {
  constructor(private readonly watch: ResourceWatchService) {}

  @Get()
  @ApiOperation({ operationId: 'listResourceAlerts' })
  @ZodResponse({ status: 200, type: ResourceAlertsDto })
  list(): ResourceAlertsWire {
    return this.watch.list();
  }

  @Post(':alertId/stop')
  @ApiOperation({ operationId: 'stopResourceAlertCommand' })
  @ZodResponse({ status: 200, type: StoppedResourceAlertCommandDto })
  stop(
    @Param('alertId') alertId: string,
  ): Promise<StoppedResourceAlertCommand> {
    return this.watch.stop(alertId);
  }

  @Post(':alertId/dismiss')
  @ApiOperation({ operationId: 'dismissResourceAlert' })
  @ZodResponse({ status: 200, type: ResourceAlertsDto })
  dismiss(@Param('alertId') alertId: string): ResourceAlertsWire {
    return this.watch.dismiss(alertId);
  }

  @Put('config')
  @UseGuards(DesktopOnlyGuard)
  @ApiOperation({ operationId: 'setResourceAlertConfig' })
  @ZodResponse({ status: 200, type: ResourceAlertConfigAckDto })
  setConfig(@Body() body: ResourceAlertConfigDto): ResourceAlertConfig {
    return this.watch.setConfig(body);
  }
}
