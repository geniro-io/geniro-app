import { describe, expect, it, vi } from 'vitest';

import type { ClaudeProbeService } from '../../agents/adapters/claude/claude-probe.service';
import { CapabilitiesService } from './capabilities.service';

describe('CapabilitiesService', () => {
  it('composes the wire from the claude mode probe', () => {
    const claudeModes = {
      acceptEdits: 'pass' as const,
      plan: 'fail' as const,
      version: 'claude 2',
      probedAt: 2,
      reason: 'installed claude does not support --permission-mode plan',
    };
    const claudeWire = vi.fn(() => claudeModes);
    const service = new CapabilitiesService({
      wireCapability: claudeWire,
    } as unknown as ClaudeProbeService);
    expect(service.capabilitiesWire()).toEqual({ claudeModes });
    expect(claudeWire).toHaveBeenCalledTimes(1);
  });
});
