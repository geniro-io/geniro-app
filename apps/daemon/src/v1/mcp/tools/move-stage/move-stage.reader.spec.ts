import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../../../teams/__tests__/team-builders';
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

  it('reads summary and reason as the text of the stage', () => {
    expect(
      readMoveStage({ action: 'complete', stage: 'build', summary: 'built' }),
    ).toEqual({ action: 'complete', stage: 'build', text: 'built' });
    expect(
      readMoveStage({ action: 'complete', stage: 'build', reason: 'built' }),
    ).toEqual({ action: 'complete', stage: 'build', text: 'built' });
  });

  it('leads each refusal with the right call, and refuses text and summary that disagree', () => {
    const lead =
      'call move_stage({action: "complete", stage: "<stage id>", text: "<what was done>"}).';
    const wrongAction = readMoveStage({
      action: 'finish',
      stage: 'build',
      summary: 'built',
    });
    expect('error' in wrongAction && wrongAction.error.split('\n')[0]).toBe(
      lead,
    );
    const clash = readMoveStage({
      action: 'complete',
      stage: 'build',
      text: 'a',
      summary: 'b',
    });
    expect('error' in clash && clash.error.split('\n')).toEqual([
      lead,
      'send text once — text and summary name the same argument and disagree',
    ]);
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
      goal: 'cause known',
      next: ['implementation', 'fix'],
    },
    { id: 'implementation', title: 'Implementation', goal: 'built' },
    {
      id: 'fix',
      title: 'Fix',
      howToWork: 'Patch the cause.',
      goal: 'tests pass',
      responsible: ['coder'],
    },
  ];

  const coder = member('coder', { name: 'Coder' });

  it('says which branch was taken and what is next', () => {
    const reply = moveStageResultText(
      {
        ok: true,
        lead: 'coder',
        previousLead: 'coder',
        team: teamOf([coder]),
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
      [coder],
    );
    expect(reply).toEqual({
      isError: false,
      text: [
        'Done: Investigation → took Fix (Implementation not taken).',
        'Now: Fix (fix) (2/2).',
        'How to work: Patch the cause.',
        'Goal: tests pass',
        'Responsible: Coder.',
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
