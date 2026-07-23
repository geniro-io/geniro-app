import { Injectable } from '@nestjs/common';

import { ClaudeProbeService } from '../../agents/services/claude-probe.service';
import type { CapabilitiesWire } from '../graphs.types';
import { CursorProbeService } from './cursor-probe.service';

/**
 * Composes GET /v1/capabilities from the per-CLI probes. Each probe owns its
 * verdict, cache, and background pre-warm; this service owns only the wire
 * shape, so the controller stays a one-call delegate.
 */
@Injectable()
export class CapabilitiesService {
  constructor(
    private readonly cursorProbe: CursorProbeService,
    private readonly claudeProbe: ClaudeProbeService,
  ) {}

  capabilitiesWire(): CapabilitiesWire {
    return {
      cursorCalls: this.cursorProbe.wireCapability(),
      claudeModes: this.claudeProbe.wireCapability(),
    };
  }
}
