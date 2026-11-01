import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../__tests__/team-builders';
import { agentsThatRunAuto, membersThatAsk } from './unattended';

describe('membersThatAsk', () => {
  it('is empty when every member runs on auto — the team can run unattended', () => {
    expect(
      membersThatAsk(
        teamOf([
          member('manager'),
          member('engineer', { agent: 'cursor-agent' }),
        ]),
      ),
    ).toEqual([]);
  });

  it('names every member that can stop on an approval, by its display name', () => {
    expect(
      membersThatAsk(
        teamOf([
          member('manager', { name: 'Manager', approval: 'ask' }),
          member('qa', { approval: 'acceptEdits' }),
          member('coder', { approval: 'auto' }),
        ]),
      ),
    ).toEqual(['Manager', 'qa']);
  });

  it('names a member on auto whose pool holds a member that asks', () => {
    expect(
      membersThatAsk(
        teamOf([
          member('engineer', {
            pool: [{ agent: 'codex' }, { agent: 'codex', approval: 'ask' }],
          }),
          member('qa', { pool: [{ agent: 'codex' }] }),
        ]),
      ),
    ).toEqual(['engineer']);
  });
});

describe('agentsThatRunAuto', () => {
  it('names each auto member by its unique id, and a pool member by its number', () => {
    const team = teamOf([
      member('a', {
        name: 'Reviewer',
        approval: 'ask',
        pool: [{ agent: 'codex', approval: 'auto' }, { agent: 'claude' }],
      }),
      member('b', { name: 'Reviewer' }),
      member('c'),
    ]);

    expect(agentsThatRunAuto(team)).toEqual([
      'Reviewer (a) — pool member 2',
      'Reviewer (b)',
      'c',
    ]);
  });
});
