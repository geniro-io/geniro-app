import { describe, expect, it, vi } from 'vitest';

import type { CapabilitiesService } from '../services/capabilities.service';
import { CapabilitiesController } from './capabilities.controller';

describe('CapabilitiesController', () => {
  it('GET delegates to CapabilitiesService.capabilitiesWire', () => {
    const wire = { agents: [], approvals: [], options: [] };
    const capabilitiesWire = vi.fn(() => wire);
    const controller = new CapabilitiesController({
      capabilitiesWire,
    } as unknown as CapabilitiesService);
    expect(controller.getCapabilities()).toBe(wire);
    expect(capabilitiesWire).toHaveBeenCalledTimes(1);
  });
});
