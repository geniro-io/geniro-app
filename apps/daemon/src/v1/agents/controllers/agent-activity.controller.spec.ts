import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import type { AgentActivityService } from '../services/agent-activity.service';
import { AgentActivityController } from './agent-activity.controller';

describe('AgentActivityController', () => {
  it("answers the service's reading", () => {
    const activity = { working: true };
    const controller = new AgentActivityController(
      activity as AgentActivityService,
    );

    expect(controller.read()).toEqual({ working: true });
    activity.working = false;
    expect(controller.read()).toEqual({ working: false });
  });

  it('serves the path Electron main asks, desktop only', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AgentActivityController)).toBe(
      'v1/agents/activity',
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AgentActivityController),
    ).toContain(DesktopOnlyGuard);
  });
});
