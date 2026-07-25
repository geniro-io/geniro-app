import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { CapabilitiesDto } from '../dto/capabilities.dto';
import type { CapabilitiesWire } from '../graphs.types';
import { CapabilitiesService } from '../services/capabilities.service';

/**
 * Route + delegation only — the per-probe verdict reads and background
 * pre-warms live behind CapabilitiesService. The builder polls this to decide
 * whether cursor call nodes need the degrade warning and which claude
 * permission modes the chat selector may offer.
 */
@Controller('v1/capabilities')
@ApiTags('capabilities')
@ApiBearerAuth()
export class CapabilitiesController {
  constructor(private readonly capabilities: CapabilitiesService) {}

  @Get()
  @ApiOperation({ operationId: 'getCapabilities' })
  @ZodResponse({ status: 200, type: CapabilitiesDto })
  getCapabilities(): CapabilitiesWire {
    return this.capabilities.capabilitiesWire();
  }
}
