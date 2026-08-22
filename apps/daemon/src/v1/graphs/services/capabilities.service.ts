import { Injectable } from '@nestjs/common';

import { ClaudeProbeService } from '../../agents/adapters/claude/claude-probe.service';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { GENIRO_UI_PREAMBLE } from '../../agents/utils/agent-instructions';
import type {
  AgentApprovalCapability,
  AgentConfigDirCapability,
  AgentFollowUpCapability,
  AgentModelEffortCapability,
  AgentSubagentCapability,
  AgentTerminalCapability,
  AgentUsageCapability,
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
      usage: this.usageCapabilities(),
      modelEfforts: this.modelEffortCapabilities(),
      // Served verbatim from the one constant the adapters compose, so the
      // Settings preview cannot describe a preamble the CLIs stopped getting.
      hostPreamble: GENIRO_UI_PREAMBLE,
    };
  }

  /**
   * Every registered CLI's effort-picker answer, read off its own config.
   *
   * Iterated, never listed — the same rule as the six below. It is what lets a
   * composer with no effort picker SAY where the effort is set instead, rather
   * than showing a value the user cannot change and no cause for it.
   */
  private modelEffortCapabilities(): AgentModelEffortCapability[] {
    return [...this.adapters.all()].map(([agent, adapter]) => ({
      agent,
      unavailableReason: adapter.getConfig().effortsUnavailableReason,
    }));
  }

  /**
   * Every registered CLI's usage answer, read off its own config.
   *
   * Iterated, never listed — the same rule as the five below. It is what lets an
   * empty context meter SAY why it is empty, instead of leaving "a turn that has
   * not finished" and "a CLI that never reports any" looking identical.
   */
  private usageCapabilities(): AgentUsageCapability[] {
    return [...this.adapters.all()].map(([agent, adapter]) => ({
      agent,
      unavailableReason: adapter.getConfig().usage.unavailableReason,
    }));
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
      interrupts: adapter.getConfig().followUp.interrupts,
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
   * The question here is "can this CLI reopen its conversations AT ALL", not
   * "can it reopen this thread" — so it asks
   * {@link AgentAdapter.handoffUnavailableReason}, which answers exactly that
   * and hands back the CLI's OWN sentence.
   *
   * It used to ask `handoffTarget` with a fabricated session id
   * (`'capability-probe'`) and then replace the adapter's reason with
   * `"<agent> has no interactive terminal session"`. Both halves were wrong:
   * the placeholder made a permanent refusal indistinguishable from a
   * malformed request, and the invented sentence is the one the panel shows —
   * so the user was told "no interactive terminal session" while the daemon
   * knew, and `GET /v1/handoff` was already returning, that ACP sessions are
   * not in cursor-agent's chat store and resuming one opens an empty chat.
   */
  private terminalCapabilities(): AgentTerminalCapability[] {
    return [...this.adapters.all()].map(([agent, adapter]) => ({
      agent,
      unavailableReason: adapter.handoffUnavailableReason(),
    }));
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
