import { describe, expect, it, vi } from 'vitest';

import type { CapabilitiesService } from '../services/capabilities.service';
import { CapabilitiesController } from './capabilities.controller';

describe('CapabilitiesController', () => {
  it('GET delegates to CapabilitiesService.capabilitiesWire', () => {
    const wire = {
      cursorCalls: {
        status: 'pass' as const,
        version: 'v1',
        probedAt: 1,
        reason: null,
      },
      claudeModes: {
        acceptEdits: 'pass' as const,
        plan: 'pass' as const,
        version: 'v2',
        probedAt: 2,
        reason: null,
      },
    };
    const capabilitiesWire = vi.fn(() => wire);
    const controller = new CapabilitiesController({
      capabilitiesWire,
    } as unknown as CapabilitiesService);
    expect(controller.getCapabilities()).toBe(wire);
    expect(capabilitiesWire).toHaveBeenCalledTimes(1);
  });
});
