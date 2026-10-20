import { describe, expect, it, vi } from 'vitest';

import { WorkflowsController } from './workflows.controller';

describe('POST /v1/workflows/runs/:runId/actions/:seq/press|dismiss', () => {
  function actionController() {
    const actions = {
      press: vi.fn(async () => ({ outcome: {} })),
      dismiss: vi.fn(async () => ({ outcome: {} })),
    };
    const controller = Object.create(
      WorkflowsController.prototype,
    ) as WorkflowsController;
    Object.assign(controller, { actions });
    return { controller, actions };
  }

  it('records a press through the gateway as remote, and one without the stamp as desktop', async () => {
    const { controller, actions } = actionController();

    await controller.pressAction(
      'run-w',
      4,
      { clientMessageId: 'c1' },
      { 'x-geniro-via': 'remote' },
    );
    await controller.pressAction('run-w', 4, { clientMessageId: 'c2' }, {});

    expect(actions.press.mock.calls).toEqual([
      ['run-w', 4, 'c1', 'remote'],
      ['run-w', 4, 'c2', 'desktop'],
    ]);
  });

  it('records a dismissal through the gateway as remote', async () => {
    const { controller, actions } = actionController();

    await controller.dismissAction('run-w', 4, { 'x-geniro-via': 'remote' });

    expect(actions.dismiss).toHaveBeenCalledWith('run-w', 4, 'remote');
  });
});
