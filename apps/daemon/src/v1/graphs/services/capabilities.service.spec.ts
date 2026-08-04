import { describe, expect, it, vi } from 'vitest';

import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import type { ClaudeProbeService } from '../../agents/adapters/claude/claude-probe.service';
import { CursorAcpAdapter } from '../../agents/adapters/cursor-acp/cursor-acp.adapter';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { CapabilitiesService } from './capabilities.service';

const CLAUDE_MODES = {
  acceptEdits: 'pass' as const,
  plan: 'fail' as const,
  version: 'claude 2',
  probedAt: 2,
  reason: 'installed claude does not support --permission-mode plan',
};

function registry(): AgentAdapterRegistry {
  return new AgentAdapterRegistry(new ClaudeAdapter(), new CursorAcpAdapter());
}

function service(claudeWire = vi.fn(() => CLAUDE_MODES)): {
  service: CapabilitiesService;
  claudeWire: typeof claudeWire;
} {
  return {
    service: new CapabilitiesService(
      { wireCapability: claudeWire } as unknown as ClaudeProbeService,
      registry(),
    ),
    claudeWire,
  };
}

describe('CapabilitiesService', () => {
  it('composes the wire from the claude mode probe', () => {
    const { service: subject, claudeWire } = service();

    expect(subject.capabilitiesWire()).toMatchObject({
      claudeModes: CLAUDE_MODES,
    });
    expect(claudeWire).toHaveBeenCalledTimes(1);
  });

  it('answers for EVERY registered CLI, not a hand-written list', () => {
    // Why the composition iterates the registry: a third adapter must appear
    // here the moment it is registered. A literal naming the two shipped CLIs
    // would leave the renderer with no answer for the third, and it would fall
    // back to allowlisting one agent by name — the exact shape this wire field
    // exists to replace.
    expect(
      service()
        .service.capabilitiesWire()
        .plugins.map((p) => p.agent),
    ).toEqual([...registry().all().keys()]);
  });

  it('carries each adapter’s OWN plugin reason, verbatim', () => {
    // Not a boolean, and not a sentence composed here: the renderer SHOWS this
    // string, and a reason invented at the wire layer is one the adapter
    // cannot keep true. Reading it off the config is what lets a CLI that
    // gains plugin support need no change in this file at all.
    const byAgent = new Map(
      service()
        .service.capabilitiesWire()
        .plugins.map((p) => [p.agent, p.unavailableReason]),
    );

    expect(byAgent.get('claude')).toBe(
      new ClaudeAdapter().getConfig().plugin.unavailableReason,
    );
    expect(byAgent.get('cursor-agent')).toBe(
      new CursorAcpAdapter().getConfig().plugin.unavailableReason,
    );
  });

  it('states claude’s support as null and cursor’s refusal as a real sentence', () => {
    // The two live values. `null` is the affirmative answer; a non-empty
    // string is both the refusal and the reason shown for it — an empty one
    // would render as a refusal with no explanation, which is the silent
    // failure the field was added to prevent.
    const byAgent = new Map(
      service()
        .service.capabilitiesWire()
        .plugins.map((p) => [p.agent, p.unavailableReason]),
    );

    expect(byAgent.get('claude')).toBeNull();
    expect(byAgent.get('cursor-agent')).toEqual(expect.any(String));
    expect(byAgent.get('cursor-agent')).not.toBe('');
  });
});
