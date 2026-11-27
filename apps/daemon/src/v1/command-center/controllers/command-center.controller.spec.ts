import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ForbiddenException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import {
  REMOTE_VIA_HEADER,
  REMOTE_VIA_VALUE,
} from '../../../auth/remote-marker';
import { NOTICE_ITEMS_MAX } from '../command-center.types';
import {
  SettingsNoticeReadingsDto,
  startThreadRunSchema,
} from '../dto/command-center.dto';
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

function passesGuards(
  method: keyof CommandCenterController,
  headers: Record<string, string>,
): boolean {
  return guardsOf(method).every((guard) =>
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
        passesGuards('startRun', { [REMOTE_VIA_HEADER]: REMOTE_VIA_VALUE });
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
      expect(passesGuards('startRun', {})).toBe(true);
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

  describe('the Settings notices', () => {
    it('takes readings from the desktop only, and refuses a paired device', () => {
      expect(guardsOf('reportNoticeReadings')).toContain(DesktopOnlyGuard);
      expect(() =>
        passesGuards('reportNoticeReadings', {
          [REMOTE_VIA_HEADER]: REMOTE_VIA_VALUE,
        }),
      ).toThrow(ForbiddenException);
    });

    it('lets any device read and dismiss them, and dismiss a Done card', () => {
      expect(guardsOf('listNotices')).toEqual([]);
      expect(guardsOf('dismissNotice')).toEqual([]);
      expect(guardsOf('dismissDone')).toEqual([]);
    });

    it('refuses a reading with more items than a notice holds, or a kind the daemon reads itself', () => {
      const schema = SettingsNoticeReadingsDto.schema;
      expect(
        schema.safeParse({
          readings: [
            {
              kind: 'agent-updates',
              items: Array.from(
                { length: NOTICE_ITEMS_MAX + 1 },
                (_, index) => `cli${index}@1`,
              ),
            },
          ],
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          readings: [{ kind: 'memory-conflicts', items: ['f1'] }],
        }).success,
      ).toBe(false);
    });
  });

  describe('reporting a start that failed', () => {
    it('is desktop only: only Electron main reports one', () => {
      expect(guardsOf('failed')).toContain(DesktopOnlyGuard);
    });

    it('refuses a paired device with 403 DESKTOP_ONLY, so it cannot end a start or wake the manager', () => {
      let refusal: unknown = null;
      try {
        passesGuards('failed', { [REMOTE_VIA_HEADER]: REMOTE_VIA_VALUE });
      } catch (error) {
        refusal = error;
      }

      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect(refusal).toMatchObject({
        statusCode: 403,
        errorCode: 'DESKTOP_ONLY',
      });
    });

    it('lets the desktop drain report through', () => {
      expect(passesGuards('failed', {})).toBe(true);
    });
  });
});
