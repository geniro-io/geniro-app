import { ConflictException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import type { GoalsWriteOutcome } from '../chat.types';
import type { GoalsService } from '../services/goals.service';
import { GoalsController } from './goals.controller';

describe('GoalsController', () => {
  it('keeps the user’s close of a closed goal a 409 GOAL_CLOSED', async () => {
    const reason = 'g1 is already closed (achieved) — nothing changed';
    const outcome: GoalsWriteOutcome = {
      status: 'unchanged',
      goals: [],
      reason,
    };
    const controller = new GoalsController({
      close: () => Promise.resolve(outcome),
    } as unknown as GoalsService);

    const closed = controller.close('run-1', 'g1', {
      status: 'achieved',
      evidence: 'done',
    });

    await expect(closed).rejects.toBeInstanceOf(ConflictException);
    await expect(closed).rejects.toMatchObject({
      errorCode: 'GOAL_CLOSED',
      message: reason,
    });
  });
});
