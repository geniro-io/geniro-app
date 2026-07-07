import { describe, expect, it, vi } from 'vitest';

import type { CursorProbeService } from '../services/cursor-probe.service';
import { CapabilitiesController } from './capabilities.controller';

describe('CapabilitiesController', () => {
  it('GET delegates to CursorProbeService.capabilitiesWire', () => {
    const wire = {
      cursorCalls: {
        status: 'pass' as const,
        version: 'v1',
        probedAt: 1,
        reason: null,
      },
    };
    const capabilitiesWire = vi.fn(() => wire);
    const controller = new CapabilitiesController({
      capabilitiesWire,
    } as unknown as CursorProbeService);
    expect(controller.getCapabilities()).toBe(wire);
    expect(capabilitiesWire).toHaveBeenCalledTimes(1);
  });
});
