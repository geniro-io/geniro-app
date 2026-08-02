import { Inject, Injectable } from '@nestjs/common';

import type { AgentAdapter } from '../../agents/adapters/agent-adapter';
import { CURSOR_ADAPTER } from '../../agents/chat.types';
import { ClaudeProbeService } from '../../agents/services/claude-probe.service';
import type { CapabilitiesWire, CursorCallsCapability } from '../graphs.types';
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
    @Inject(CURSOR_ADAPTER) private readonly cursor: AgentAdapter,
  ) {}

  capabilitiesWire(): CapabilitiesWire {
    return {
      cursorCalls: this.cursorCalls(),
      claudeModes: this.claudeProbe.wireCapability(),
    };
  }

  /**
   * The MCP-trust probe answers "will this cursor-agent honour a server we
   * planted in `.cursor/mcp.json`?" — a question that only exists because the
   * legacy adapter has no other delivery route. An adapter that hands the
   * endpoint over in-protocol is capable by construction, so report the pass
   * directly instead of making the builder wait on a probe turn whose verdict
   * no longer gates anything. Mirrors the executor's `callCapable`, which keys
   * on the same adapter property.
   */
  private cursorCalls(): CursorCallsCapability {
    if (!this.cursor.deliversMcpEndpoint) {
      return this.cursorProbe.wireCapability();
    }
    return {
      status: 'pass',
      version: null,
      probedAt: null,
      reason: null,
    };
  }
}
