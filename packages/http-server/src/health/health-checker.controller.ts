import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AppBootstrapperConfigService } from '@packages/common';

import { HealthStatus } from '../http-server.types';
import { HealthCheckResponseDto } from './health-check-response.dto';

@Controller({
  path: 'health',
  version: VERSION_NEUTRAL,
})
@ApiTags('health')
@ApiExcludeController()
export class HealthCheckerController {
  constructor(
    private readonly appBootstrapperConfigService: AppBootstrapperConfigService,
  ) {}

  @Get('check')
  @ApiOkResponse({
    description: 'Service health check',
    type: HealthCheckResponseDto,
  })
  public async check(): Promise<HealthCheckResponseDto> {
    return {
      status: HealthStatus.Ok,
      version: this.appBootstrapperConfigService.appVersion,
    };
  }
}
