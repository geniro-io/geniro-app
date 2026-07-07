import { Controller, Get } from '@nestjs/common';

import type { CapabilitiesWire } from '../graphs.types';
import { CursorProbeService } from '../services/cursor-probe.service';

/**
 * Route + delegation only — the verdict read and the background pre-warm live
 * in CursorProbeService. The builder polls this to decide whether cursor
 * nodes with outgoing call edges need the degrade warning.
 */
@Controller('v1/capabilities')
export class CapabilitiesController {
  constructor(private readonly cursorProbe: CursorProbeService) {}

  @Get()
  getCapabilities(): CapabilitiesWire {
    return this.cursorProbe.capabilitiesWire();
  }
}
