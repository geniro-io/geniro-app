import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';

import type { WaitingMessageWire } from '../chat.types';
import type { ThreadInboxService } from '../services/thread-inbox.service';
import { ThreadMessagesController } from './thread-messages.controller';

const RUN = 'run-1';

function setup(inbox: Partial<ThreadInboxService>): ThreadMessagesController {
  const controller = Object.create(
    ThreadMessagesController.prototype,
  ) as ThreadMessagesController;
  Object.assign(controller, { inbox });
  return controller;
}

describe('GET /v1/threads/:runId/waiting-messages', () => {
  it('hands the inbox the thread and answers its waiting list', async () => {
    const rows: WaitingMessageWire[] = [
      {
        id: 'm1',
        fromRunId: 'alpha',
        fromTitle: 'Alpha',
        fromMember: null,
        text: 'the build is green',
        reason: 'running_turn',
        createdAt: '2026-11-06T10:00:00.000Z',
      },
    ];
    const listWaiting = vi.fn(() => Promise.resolve(rows));

    expect(await setup({ listWaiting }).list(RUN)).toEqual(rows);
    expect(listWaiting).toHaveBeenCalledWith(RUN);
  });
});

describe('DELETE /v1/threads/:runId/waiting-messages/:messageId', () => {
  it('hands the inbox the thread and the message the user removed', async () => {
    const remove = vi.fn(() => Promise.resolve());

    await setup({ remove }).remove(RUN, 'm1');

    expect(remove).toHaveBeenCalledWith(RUN, 'm1');
  });
});

describe('ThreadMessagesController routes', () => {
  it('is served under the thread, carries no guard a paired phone would fail, and answers a removal with 204', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ThreadMessagesController)).toBe(
      'v1/threads/:runId/waiting-messages',
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, ThreadMessagesController),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        ThreadMessagesController.prototype.list,
      ),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        ThreadMessagesController.prototype.remove,
      ),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        ThreadMessagesController.prototype.remove,
      ),
    ).toBe(204);
  });
});
