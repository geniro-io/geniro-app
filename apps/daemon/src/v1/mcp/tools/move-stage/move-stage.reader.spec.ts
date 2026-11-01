import { describe, expect, it } from 'vitest';

import type { TeamStage } from '../../../teams/teams.types';
import { moveStageResultText, readMoveStage } from './move-stage.reader';

describe('readMoveStage', () => {
  it('reads every field, leaving next out when unset', () => {
    expect(
      readMoveStage({
        action: 'complete',
        stage: ' investigation ',
        next: 'fix',
        text: 'cause found',
      }),
    ).toEqual({
      action: 'complete',
      stage: 'investigation',
      next: 'fix',
      text: 'cause found',
    });
    expect(
      readMoveStage({ action: 'skip', stage: 'fix', text: 'n/a', next: null }),
    ).toEqual({ action: 'skip', stage: 'fix', text: 'n/a' });
  });

  it('refuses an unknown action, a missing stage and unknown arguments', () => {
    expect(
      readMoveStage({ action: 'finish', stage: 'a', text: 'x' }),
    ).toHaveProperty('error');
    expect(readMoveStage({ action: 'skip', text: 'x' })).toHaveProperty(
      'error',
    );
    expect(
      readMoveStage({ action: 'skip', stage: 'a', text: 'x', run_id: 'r' }),
    ).toHaveProperty('error');
  });
});

describe('moveStageResultText', () => {
  const stages: TeamStage[] = [
    {
      id: 'investigation',
      title: 'Investigation',
      doneWhen: 'cause known',
      next: ['implementation', 'fix'],
    },
    { id: 'implementation', title: 'Implementation', doneWhen: 'built' },
    {
      id: 'fix',
      title: 'Fix',
      instructions: 'Patch the cause.',
      doneWhen: 'tests pass',
      ownerHint: 'coder',
    },
  ];

  it('says which branch was taken and what is next', () => {
    const reply = moveStageResultText(
      {
        ok: true,
        team: { name: 'w', nodes: [], edges: [] },
        stages,
        progress: {
          rev: 1,
          current: 'fix',
          position: { index: 2, total: 2 },
          stages: [],
        },
        resets: [],
        payload: {
          action: 'complete',
          stageId: 'investigation',
          stageTitle: 'Investigation',
          next: 'fix',
          text: 'found',
          rev: 1,
          by: { kind: 'agent', nodeId: 'lead' },
        },
      },
      [{ id: 'coder', kind: 'agent', agent: 'claude', approval: 'auto' }],
    );
    expect(reply).toEqual({
      isError: false,
      text: [
        'Done: Investigation → took Fix (Implementation not taken).',
        'Now: Fix (fix) (2/2).',
        'What to do: Patch the cause.',
        'Done when: tests pass',
        'Usually done by: coder.',
      ].join('\n'),
    });
  });

  it('words a refusal as its code and message', () => {
    expect(
      moveStageResultText(
        {
          ok: false,
          code: 'STAGE_NOT_CURRENT',
          message: 'the current stage is Fix (fix).',
        },
        [],
      ),
    ).toEqual({
      isError: true,
      text: 'STAGE_NOT_CURRENT: the current stage is Fix (fix).',
    });
  });
});
