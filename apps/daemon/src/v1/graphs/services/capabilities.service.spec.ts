import { describe, expect, it, vi } from 'vitest';

import type { ClaudeProbeService } from '../../agents/services/claude-probe.service';
import { CapabilitiesService } from './capabilities.service';

const CLAUDE_MODES = {
  acceptEdits: 'pass' as const,
  plan: 'fail' as const,
  version: 'claude 2',
  probedAt: 2,
  reason: 'installed claude does not support --permission-mode plan',
};

describe('CapabilitiesService', () => {
  it('composes the wire from the claude probe, keeping its pre-warm', () => {
    const claudeWire = vi.fn(() => CLAUDE_MODES);
    const service = new CapabilitiesService({
      wireCapability: claudeWire,
    } as unknown as ClaudeProbeService);
    expect(service.capabilitiesWire()).toEqual({ claudeModes: CLAUDE_MODES });
    expect(claudeWire).toHaveBeenCalledTimes(1);
  });
});
