import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ForbiddenException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import {
  REMOTE_VIA_HEADER,
  REMOTE_VIA_VALUE,
} from '../../../auth/remote-marker';
import { startThreadRunSchema } from '../dto/command-center.dto';
import { CommandCenterController } from './command-center.controller';

const START_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function guardsOf(method: keyof CommandCenterController): unknown[] {
  return (Reflect.getMetadata(
    GUARDS_METADATA,
    CommandCenterController.prototype[method],
  ) ?? []) as unknown[];
}

function requestWith(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function passesStartRunGuards(headers: Record<string, string>): boolean {
  return guardsOf('startRun').every((guard) =>
    new (guard as new () => DesktopOnlyGuard)().canActivate(
      requestWith(headers),
    ),
  );
}

describe('CommandCenterController', () => {
  describe('starting a cardless thread', () => {
    it('is desktop only: only Electron main starts one', () => {
      expect(guardsOf('startRun')).toContain(DesktopOnlyGuard);
    });

    it('refuses a paired device with 403 DESKTOP_ONLY', () => {
      let refusal: unknown = null;
      try {
        passesStartRunGuards({ [REMOTE_VIA_HEADER]: REMOTE_VIA_VALUE });
      } catch (error) {
        refusal = error;
      }

      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect(refusal).toMatchObject({
        statusCode: 403,
        errorCode: 'DESKTOP_ONLY',
      });
    });

    it('lets the desktop drain through', () => {
      expect(passesStartRunGuards({})).toBe(true);
    });

    it('takes no folder from the request: a cwd in the body never reaches the start', () => {
      const parsed = startThreadRunSchema.parse({
        cwd: '/Users/someone/elsewhere',
        startSha: START_SHA,
        startDirty: false,
      });

      expect(parsed).toEqual({ startSha: START_SHA, startDirty: false });
    });
  });
});
