import { describe, expect, it } from 'vitest';

import { KeptSessionConfigSchema } from '../chat.types';
import { AgentSessionRegistry } from '../services/agent-session.registry';
import { KeptSessionsController } from './kept-sessions.controller';

describe('KeptSessionsController', () => {
  it('holds 60 minutes until the first push, then what was pushed', () => {
    const registry = new AgentSessionRegistry(3);
    const controller = new KeptSessionsController(registry);

    expect(registry.idleMinutes).toBe(60);
    expect(controller.setConfig({ idleMinutes: 5 })).toEqual({
      idleMinutes: 5,
    });
    expect(registry.idleMinutes).toBe(5);
  });

  it('takes a whole number of minutes from 5 to 180', () => {
    for (const idleMinutes of [5, 60, 180]) {
      expect(KeptSessionConfigSchema.safeParse({ idleMinutes }).success).toBe(
        true,
      );
    }
    for (const idleMinutes of [4, 181, 30.5, 0, -60]) {
      expect(KeptSessionConfigSchema.safeParse({ idleMinutes }).success).toBe(
        false,
      );
    }
    expect(KeptSessionConfigSchema.safeParse({}).success).toBe(false);
  });
});
