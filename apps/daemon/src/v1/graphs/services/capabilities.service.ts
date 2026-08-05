import { Injectable } from '@nestjs/common';

import { ClaudeProbeService } from '../../agents/adapters/claude/claude-probe.service';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type {
  AgentPluginCapability,
  AgentTerminalCapability,
  CapabilitiesWire,
} from '../graphs.types';

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
      interactiveTerminals: this.terminalCapabilities(),
    };
  }

  /**
   * Every registered CLI's interactive-terminal answer, asked of its own
   * adapter. Iterated, never listed — same rule as the plugin row above.
   *
   * `terminalCommand` is asked with a placeholder session id because the
   * question here is "does this CLI have a mirror AT ALL", not "can it mirror
   * this thread": a `no-session` refusal is a not-YET and still means the CLI
   * supports one. Only `unsupported` is the permanent answer this reports.
   */
  private terminalCapabilities(): AgentTerminalCapability[] {
    return [...this.adapters.all()].map(([agent, adapter]) => {
      const resolved = adapter.terminalCommand({
        sessionId: 'capability-probe',
        model: null,
      });
      return {
        agent,
        unavailableReason:
          !resolved.ok && resolved.reason === 'unsupported'
            ? `${agent} has no interactive terminal session`
            : null,
      };
    });
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
