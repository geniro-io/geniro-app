import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../__tests__/team-builders';
import type { TeamStage } from '../teams.types';
import { foldStages } from './stage-fold';
import { currentLeadOf, leadOf, possibleLeadsOf } from './team-roster';

const MEMBERS = [
  member('ada', { name: 'Ada' }),
  member('bob', { name: 'Bob' }),
  member('cy', { name: 'Cy' }),
];

const STAGES: TeamStage[] = [
  {
    id: 'plan',
    title: 'Plan',
    goal: 'a plan',
    responsible: ['ada'],
    next: ['build'],
  },
  {
    id: 'build',
    title: 'Build',
    goal: 'built',
    responsible: ['bob', 'cy'],
    next: ['review', 'ship'],
  },
  { id: 'review', title: 'Review', goal: 'approved', responsible: ['cy'] },
  { id: 'ship', title: 'Ship', goal: 'shipped' },
];

const onBuild = () =>
  foldStages(STAGES, [
    {
      action: 'complete',
      stageId: 'plan',
      text: 'planned it',
      by: { kind: 'agent', nodeId: 'ada' },
      at: '2026-11-01T10:00:00.000Z',
    },
  ]);

describe('team leads', () => {
  it('is the current stage’s lead in relay mode, else the previous one, else the trigger’s member', () => {
    const relay = teamOf(MEMBERS, { mode: 'relay', stages: STAGES });
    expect(currentLeadOf(relay, foldStages(STAGES, []))).toBe('ada');
    expect(currentLeadOf(relay, onBuild())).toBe('bob');
    const onShip = foldStages(STAGES, [
      ...[
        { stageId: 'plan', by: 'ada' },
        { stageId: 'build', by: 'bob', next: 'ship' },
      ].map((m) => ({
        action: 'complete' as const,
        stageId: m.stageId,
        ...(m.next === undefined ? {} : { next: m.next }),
        text: 'done',
        by: { kind: 'agent' as const, nodeId: m.by },
        at: '2026-11-01T10:00:00.000Z',
      })),
    ]);
    expect(onShip.current).toBe('ship');
    expect(currentLeadOf(relay, onShip)).toBe('bob');
    expect(leadOf(relay, { current: 'ship' }, null)).toBe('ada');
    expect(currentLeadOf(teamOf(MEMBERS, { stages: STAGES }), onBuild())).toBe(
      'ada',
    );
    expect([...possibleLeadsOf(relay)].sort()).toEqual(['ada', 'bob', 'cy']);
  });
});
