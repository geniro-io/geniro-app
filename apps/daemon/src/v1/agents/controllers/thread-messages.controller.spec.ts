import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { ThreadMessagesController } from './thread-messages.controller';

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
