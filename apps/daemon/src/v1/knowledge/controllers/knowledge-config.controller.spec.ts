import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import { KnowledgeConfigController } from './knowledge-config.controller';

describe('KnowledgeConfigController', () => {
  it('is desktop only: a paired device may not change the setting', () => {
    const guards =
      (Reflect.getMetadata(GUARDS_METADATA, KnowledgeConfigController) as
        unknown[] | undefined) ?? [];
    expect(guards).toContain(DesktopOnlyGuard);
  });
});
