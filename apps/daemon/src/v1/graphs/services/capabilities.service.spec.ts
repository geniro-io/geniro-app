import { describe, expect, it, vi } from 'vitest';

import type { AgentAdapter } from '../../agents/adapters/agent-adapter';
import type { ClaudeProbeService } from '../../agents/services/claude-probe.service';
import { CapabilitiesService } from './capabilities.service';
import type { CursorProbeService } from './cursor-probe.service';

const CURSOR_CALLS = {
  status: 'pass' as const,
  version: 'cursor 1',
  probedAt: 1,
  reason: null,
};
const CLAUDE_MODES = {
  acceptEdits: 'pass' as const,
  plan: 'fail' as const,
  version: 'claude 2',
  probedAt: 2,
  reason: 'installed claude does not support --permission-mode plan',
};

function build(deliversMcpEndpoint: boolean): {
  service: CapabilitiesService;
  cursorWire: ReturnType<typeof vi.fn>;
  claudeWire: ReturnType<typeof vi.fn>;
} {
  const cursorWire = vi.fn(() => CURSOR_CALLS);
  const claudeWire = vi.fn(() => CLAUDE_MODES);
  const service = new CapabilitiesService(
    { wireCapability: cursorWire } as unknown as CursorProbeService,
    { wireCapability: claudeWire } as unknown as ClaudeProbeService,
    { deliversMcpEndpoint } as unknown as AgentAdapter,
  );
  return { service, cursorWire, claudeWire };
}

describe('CapabilitiesService', () => {
  it('composes the wire from both probes (each arm keeps its own pre-warm)', () => {
    const { service, cursorWire, claudeWire } = build(false);
    expect(service.capabilitiesWire()).toEqual({
      cursorCalls: CURSOR_CALLS,
      claudeModes: CLAUDE_MODES,
    });
    expect(cursorWire).toHaveBeenCalledTimes(1);
    expect(claudeWire).toHaveBeenCalledTimes(1);
  });

  it('reports cursor calls as available without probing when the adapter delivers the endpoint itself', () => {
    // The MCP-trust probe only answers "will a planted .cursor/mcp.json be
    // honoured?" — a question the ACP transport never asks, so the builder must
    // not be made to wait on a probe turn whose verdict gates nothing.
    const { service, cursorWire } = build(true);
    expect(service.capabilitiesWire().cursorCalls).toEqual({
      status: 'pass',
      version: null,
      probedAt: null,
      reason: null,
    });
    expect(cursorWire).not.toHaveBeenCalled();
  });
});
