import { Controller, Get } from '@nestjs/common';

import type { CapabilitiesWire } from '../graphs.types';
import { CapabilitiesService } from '../services/capabilities.service';

/**
 * Route + delegation only — the per-probe verdict reads and background
 * pre-warms live behind CapabilitiesService. The builder polls this to decide
 * whether cursor call nodes need the degrade warning and which claude
 * permission modes the chat selector may offer.
 */
@Controller('v1/capabilities')
export class CapabilitiesController {
  constructor(private readonly capabilities: CapabilitiesService) {}

  @Get()
  getCapabilities(): CapabilitiesWire {
    return this.capabilities.capabilitiesWire();
  }
}
