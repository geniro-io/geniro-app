import { describe, expect, it, vi } from 'vitest';

import type { RestartContinuationService } from '../services/restart-continuation.service';
import { HeldRunsController } from './held-runs.controller';

describe('HeldRunsController', () => {
  it('lists the held runs the restart continuation reads', async () => {
    const runs = [{ runId: 'run-1', title: 'Fix login', cause: 'crash' }];
    const controller = new HeldRunsController({
      listHeld: vi.fn(async () => runs),
    } as unknown as RestartContinuationService);

    expect(await controller.list()).toEqual({ runs });
  });

  it('hands the user’s choice to the restart continuation and answers what it did', async () => {
    const answered = { continued: ['run-1'], declined: ['run-2'] };
    const answerHeld = vi.fn(async () => answered);
    const controller = new HeldRunsController({
      answerHeld,
    } as unknown as RestartContinuationService);
    const body = { continueRunIds: ['run-1'], declineRunIds: ['run-2'] };

    expect(await controller.answer(body)).toBe(answered);
    expect(answerHeld).toHaveBeenCalledWith(body);
  });
});
