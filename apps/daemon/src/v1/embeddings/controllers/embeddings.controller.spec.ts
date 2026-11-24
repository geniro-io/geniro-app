import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import { EmbeddingsController } from './embeddings.controller';

function guardsOf(
  method: keyof Pick<EmbeddingsController, 'setConfig' | 'status' | 'clear'>,
): unknown[] {
  return (Reflect.getMetadata(
    GUARDS_METADATA,
    EmbeddingsController.prototype[method],
  ) ?? []) as unknown[];
}

describe('EmbeddingsController', () => {
  it.each(['setConfig', 'clear'] as const)(
    '%s is desktop only: a paired device may not change the search index',
    (method) => {
      expect(guardsOf(method)).toContain(DesktopOnlyGuard);
    },
  );

  it('status stays open to a paired device, so Settings → Search reads it there', () => {
    expect(guardsOf('status')).not.toContain(DesktopOnlyGuard);
    expect(
      (Reflect.getMetadata(GUARDS_METADATA, EmbeddingsController) ??
        []) as unknown[],
    ).not.toContain(DesktopOnlyGuard);
  });
});
