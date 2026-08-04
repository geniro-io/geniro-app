import { Injectable } from '@nestjs/common';

import { ClaudeProbeService } from '../../agents/adapters/claude/claude-probe.service';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type { AgentPluginCapability, CapabilitiesWire } from '../graphs.types';

/**
 * Composes GET /v1/capabilities from the per-CLI probes and adapter configs.
 * Each adapter owns its own answer; this service owns only the wire shape, so
 * the controller stays a one-call delegate.
 */
@Injectable()
export class CapabilitiesService {
  constructor(
    private readonly claudeProbe: ClaudeProbeService,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  capabilitiesWire(): CapabilitiesWire {
    return {
      claudeModes: this.claudeProbe.wireCapability(),
      plugins: this.pluginCapabilities(),
    };
  }

  /**
   * Every registered CLI's plugin-directory answer, read off its own config.
   *
   * Composed by ITERATING the registry rather than naming the CLIs, so a third
   * adapter appears here the moment it is registered — a hand-written list is
   * how the renderer ends up allowlisting one agent again.
   */
  private pluginCapabilities(): AgentPluginCapability[] {
    return [...this.adapters.all()].map(([agent, adapter]) => ({
      agent,
      unavailableReason: adapter.getConfig().plugin.unavailableReason,
    }));
  }
}
