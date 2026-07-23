import { describe, expect, it, vi } from 'vitest';

import type { ClaudeProbeService } from '../../agents/services/claude-probe.service';
import { CapabilitiesService } from './capabilities.service';
import type { CursorProbeService } from './cursor-probe.service';

describe('CapabilitiesService', () => {
  it('composes the wire from both probes (each arm keeps its own pre-warm)', () => {
    const cursorCalls = {
      status: 'pass' as const,
      version: 'cursor 1',
      probedAt: 1,
      reason: null,
    };
    const claudeModes = {
      acceptEdits: 'pass' as const,
      plan: 'fail' as const,
      version: 'claude 2',
      probedAt: 2,
      reason: 'installed claude does not support --permission-mode plan',
    };
    const cursorWire = vi.fn(() => cursorCalls);
    const claudeWire = vi.fn(() => claudeModes);
    const service = new CapabilitiesService(
      { wireCapability: cursorWire } as unknown as CursorProbeService,
      { wireCapability: claudeWire } as unknown as ClaudeProbeService,
    );
    expect(service.capabilitiesWire()).toEqual({ cursorCalls, claudeModes });
    expect(cursorWire).toHaveBeenCalledTimes(1);
    expect(claudeWire).toHaveBeenCalledTimes(1);
  });
});
