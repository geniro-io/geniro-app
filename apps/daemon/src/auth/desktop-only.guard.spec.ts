import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { SharesController } from '../v1/shares/controllers/shares.controller';
import { DesktopOnlyGuard } from './desktop-only.guard';

function contextWith(
  headers: Record<string, string | string[]>,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('DesktopOnlyGuard', () => {
  const guard = new DesktopOnlyGuard();

  it('lets a desktop request through', () => {
    expect(guard.canActivate(contextWith({}))).toBe(true);
  });

  it('refuses a request the gateway marked as coming from a paired device', () => {
    expect(() =>
      guard.canActivate(contextWith({ 'x-geniro-via': 'remote' })),
    ).toThrow(/only available on the Mac/);
  });

  it('refuses a repeated header that carries the mark anywhere', () => {
    expect(() =>
      guard.canActivate(contextWith({ 'x-geniro-via': ['desktop', 'remote'] })),
    ).toThrow(/only available on the Mac/);
  });

  it('guards every shares route', () => {
    const guards: unknown[] =
      Reflect.getMetadata(GUARDS_METADATA, SharesController) ?? [];
    expect(guards).toContain(DesktopOnlyGuard);
  });
});
