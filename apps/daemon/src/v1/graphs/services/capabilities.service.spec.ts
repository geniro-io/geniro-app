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
        .configDirs.map((p) => p.agent),
    ).toEqual([...registry().all().keys()]);
  });

  it('carries each adapter’s OWN config-directory reason, verbatim', () => {
    // Not a boolean, and not a sentence composed here: the renderer SHOWS this
    // string, and a reason invented at the wire layer is one the adapter
    // cannot keep true. Reading it off the config is what lets a CLI that
    // gains config-directory support need no change in this file at all.
    const byAgent = new Map(
      service()
        .service.capabilitiesWire()
        .configDirs.map((p) => [p.agent, p.unavailableReason]),
    );

    expect(byAgent.get('claude')).toBe(
      new ClaudeAdapter().getConfig().configDir.unavailableReason,
    );
    expect(byAgent.get('cursor-agent')).toBe(
      new CursorAcpAdapter().getConfig().configDir.unavailableReason,
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
        .configDirs.map((p) => [p.agent, p.unavailableReason]),
    );

    expect(byAgent.get('claude')).toBeNull();
    expect(byAgent.get('cursor-agent')).toEqual(expect.any(String));
    expect(byAgent.get('cursor-agent')).not.toBe('');
  });
});

describe('CapabilitiesService — a message into a running turn', () => {
  const followUps = (): Map<string, string | null> =>
    new Map(
      service()
        .service.capabilitiesWire()
        .followUps.map((f) => [f.agent, f.unavailableReason]),
    );

  it('answers for EVERY registered CLI, so the queue never allowlists one', () => {
    expect([...followUps().keys()]).toEqual([...registry().all().keys()]);
  });

  it('carries each adapter’s OWN reason, verbatim', () => {
    // Same rule as the config-dir row: the composer prints this string on the
    // disabled "send now", so a sentence composed at the wire layer is one the
    // adapter cannot keep true.
    expect(followUps().get('claude')).toBe(
      new ClaudeAdapter().getConfig().followUp.unavailableReason,
    );
    expect(followUps().get('cursor-agent')).toBe(
      new CursorAcpAdapter().getConfig().followUp.unavailableReason,
    );
  });

  it('states claude’s channel as null and cursor’s absence as a real sentence', () => {
    // The two live values. This is what decides whether the strip's Steer
    // control is offered at all — cursor's ACP `session/prompt` is one request
    // per turn, so its message genuinely cannot go out before the turn ends.
    expect(followUps().get('claude')).toBeNull();
    expect(followUps().get('cursor-agent')).toEqual(expect.any(String));
    expect(followUps().get('cursor-agent')).not.toBe('');
  });
});

describe('CapabilitiesService — the interactive terminal', () => {
  it('answers for EVERY registered CLI, so the renderer never allowlists one', () => {
    expect(
      service()
        .service.capabilitiesWire()
        .interactiveTerminals.map((t) => t.agent),
    ).toEqual([...registry().all().keys()]);
  });

  it('reports claude as available and cursor-agent as not', () => {
    // The two live values, read through each adapter's own `terminalCommand`
    // rather than restated here: cursor-acp's `terminal: null` IS the fact, and
    // a CLI that gains a mirror must need no change in this file.
    const byAgent = new Map(
      service()
        .service.capabilitiesWire()
        .interactiveTerminals.map((t) => [t.agent, t.unavailableReason]),
    );

    expect(byAgent.get('claude')).toBeNull();
    expect(byAgent.get('cursor-agent')).toEqual(expect.any(String));
    expect(byAgent.get('cursor-agent')).not.toBe('');
  });

  it('does not mistake "no session yet" for "no terminal support"', () => {
    // `terminalCommand` refuses for two different reasons and only one is
    // permanent. Probing with a placeholder session id is what keeps a claude
    // node that has simply not run yet from being reported as having no
    // interactive mirror at all — which would hide the picker forever.
    expect(
      new ClaudeAdapter().handoffTarget({ sessionId: null, model: null }),
    ).toEqual({ ok: false, reason: 'no-session' });

    const byAgent = new Map(
      service()
        .service.capabilitiesWire()
        .interactiveTerminals.map((t) => [t.agent, t.unavailableReason]),
    );
    expect(byAgent.get('claude')).toBeNull();
  });

  describe('approval modes', () => {
    it('answers for EVERY registered CLI, so the chip never decides by name', () => {
      expect(
        service()
          .service.capabilitiesWire()
          .approvals.map((a) => a.agent)
          .sort(),
      ).toEqual(['claude', 'cursor-agent']);
    });

    it('reports cursor’s real ACP modes, not an empty set', () => {
      // The composer used to render no approval chip for cursor at all, on the
      // grounds that the CLI had no per-turn approval channel. ACP gave it one,
      // and this is the fact that lets the renderer notice.
      const byAgent = new Map(
        service()
          .service.capabilitiesWire()
          .approvals.map((a) => [a.agent, a.modes]),
      );
      expect(byAgent.get('cursor-agent')).toEqual(
        new CursorAcpAdapter().getConfig().approval.modes,
      );
      expect(byAgent.get('cursor-agent')).toContain('ask');
      expect(byAgent.get('claude')).toEqual(
        new ClaudeAdapter().getConfig().approval.modes,
      );
    });
  });
});
