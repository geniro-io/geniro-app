import { Injectable } from '@nestjs/common';

import { ClaudeProbeService } from '../../agents/adapters/claude/claude-probe.service';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type {
  AgentApprovalCapability,
  AgentConfigDirCapability,
  AgentFollowUpCapability,
  AgentSubagentCapability,
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
      configDirs: this.configDirCapabilities(),
      interactiveTerminals: this.terminalCapabilities(),
      approvals: this.approvalCapabilities(),
      followUps: this.followUpCapabilities(),
      subagents: this.subagentCapabilities(),
    };
  }

  /**
   * Every registered CLI's sub-agent answer, read off its own config.
   *
   * Iterated, never listed — the same rule as the four below. It is what lets
   * a chat on a CLI that reports no delegates SAY so, instead of showing an
   * empty list a user cannot tell apart from a broken one.
   */
  private subagentCapabilities(): AgentSubagentCapability[] {
    return [...this.adapters.all()].map(([agent, adapter]) => ({
      agent,
      unavailableReason: adapter.getConfig().subagents.unavailableReason,
    }));
  }

  /**
   * Every registered CLI's mid-turn follow-up answer, read off its own config.
   *
   * Iterated, never listed — the same rule as the three below, and what lets
   * the composer's queue offer "send now" on the CLIs that have a channel for
   * one without ever learning an agent's name.
   */
  private followUpCapabilities(): AgentFollowUpCapability[] {
    return [...this.adapters.all()].map(([agent, adapter]) => ({
      agent,
      unavailableReason: adapter.getConfig().followUp.unavailableReason,
    }));
  }

  /**
   * Every registered CLI's approval modes, read off its own config — the same
   * iterate-never-list rule as the two below, and the answer the composer's
   * approval chip needs so it stops deciding by agent name.
   */
  private approvalCapabilities(): AgentApprovalCapability[] {
    return [...this.adapters.all()].map(([agent, adapter]) => ({
      agent,
      modes: [...adapter.getConfig().approval.modes],
    }));
  }

  /**
   * Every registered CLI's handoff answer, asked of its own
   * adapter. Iterated, never listed — same rule as the config-dir row above.
   *
   * `handoffTarget` is asked with a placeholder session id because the
   * question here is "can this CLI reopen its conversations AT ALL", not "can
   * it reopen this thread": a `no-session` refusal is a not-YET and still
   * means the CLI can. Only `unsupported` is the permanent answer.
   */
  private terminalCapabilities(): AgentTerminalCapability[] {
    return [...this.adapters.all()].map(([agent, adapter]) => {
      const resolved = adapter.handoffTarget({
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
   * Every registered CLI's config-directory answer, read off its own config.
   *
   * Composed by ITERATING the registry rather than naming the CLIs, so a third
   * adapter appears here the moment it is registered — a hand-written list is
   * how the renderer ends up allowlisting one agent again.
   */
  private configDirCapabilities(): AgentConfigDirCapability[] {
    return [...this.adapters.all()].map(([agent, adapter]) => ({
      agent,
      unavailableReason: adapter.getConfig().configDir.unavailableReason,
    }));
  }
}
