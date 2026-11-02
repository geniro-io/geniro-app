import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../__tests__/team-builders';
import type { TeamStage } from '../teams.types';
import {
  blockingProblemsOf,
  type ConfigurationFacts,
  healthOf,
  type MemberFacts,
  memberHealthOf,
  teamProblemsOf,
} from './member-health';

function configuration(
  overrides: Partial<ConfigurationFacts> = {},
): ConfigurationFacts {
  return {
    agent: 'claude',
    agentLabel: 'Claude Code',
    configDir: null,
    profileMissing: false,
    cli: 'installed',
    model: null,
    modelOffered: null,
    effort: null,
    effortOffered: null,
    mcpDisabled: [],
    mcp: { servers: null, checking: false },
    ...overrides,
  };
}

const facts = (...configurations: ConfigurationFacts[]): MemberFacts => ({
  configurations,
  leads: true,
});

const kinds = (problems: { kind: string }[]): string[] =>
  problems.map((entry) => entry.kind);

describe('memberHealthOf — CLI', () => {
  it('blocks when the CLI of a member with no pool is missing', () => {
    const health = memberHealthOf(
      'a',
      facts(configuration({ cli: 'missing' })),
    );

    expect(health.status).toBe('error');
    expect(health.problems).toMatchObject([
      { kind: 'cli_missing', level: 'error', poolMember: null },
    ]);
  });

  it('only warns when a pool member CLI is missing, the pool falling back', () => {
    const health = memberHealthOf(
      'a',
      facts(configuration(), configuration({ agent: 'codex', cli: 'missing' })),
    );

    expect(health.status).toBe('warning');
    expect(health.problems).toMatchObject([
      { kind: 'cli_missing', level: 'warning', poolMember: 2, agent: 'codex' },
    ]);
  });

  it('only warns when the own CLI of a pooled member is missing', () => {
    const health = memberHealthOf(
      'a',
      facts(configuration({ cli: 'missing' }), configuration()),
    );

    expect(health.problems).toMatchObject([
      { kind: 'cli_missing', level: 'warning', poolMember: null },
    ]);
  });

  it('blocks when every CLI of a leading pooled member is missing', () => {
    const health = memberHealthOf(
      'a',
      facts(
        configuration({ cli: 'missing' }),
        configuration({ agent: 'codex', cli: 'missing' }),
      ),
    );

    expect(health.status).toBe('error');
    expect(
      health.problems.map((entry) => [
        entry.kind,
        entry.level,
        entry.poolMember,
      ]),
    ).toEqual([
      ['cli_missing', 'error', null],
      ['cli_missing', 'error', 2],
    ]);
  });

  it('only warns when the CLI of a member the run does not start with is missing', () => {
    const health = memberHealthOf('a', {
      configurations: [configuration({ cli: 'missing' })],
      leads: false,
    });

    expect(health.status).toBe('warning');
    expect(health.problems).toMatchObject([
      {
        kind: 'cli_missing',
        level: 'warning',
        message:
          'Claude Code is not installed, so this member fails when the run reaches it.',
      },
    ]);
  });

  it('warns cli_unknown when the install check could not be answered', () => {
    const health = memberHealthOf(
      'a',
      facts(configuration({ cli: 'unknown' })),
    );

    expect(health.status).toBe('warning');
    expect(kinds(health.problems)).toEqual(['cli_unknown']);
  });
});

describe('memberHealthOf — profile', () => {
  it('blocks on a missing profile folder, for a pool member too', () => {
    const health = memberHealthOf(
      'a',
      facts(
        configuration(),
        configuration({ configDir: '/gone', profileMissing: true }),
      ),
    );

    expect(health.status).toBe('error');
    expect(health.problems).toMatchObject([
      {
        kind: 'profile_missing',
        level: 'error',
        poolMember: 2,
        configDir: '/gone',
      },
    ]);
  });
});

describe('memberHealthOf — model and effort', () => {
  it('warns only when the model is known not to be offered', () => {
    const unknown = memberHealthOf(
      'a',
      facts(configuration({ model: 'm', modelOffered: null })),
    );
    const refused = memberHealthOf(
      'a',
      facts(
        configuration({
          model: 'm',
          modelOffered: false,
          effort: 'high',
          effortOffered: false,
        }),
      ),
    );

    expect(unknown.problems).toEqual([]);
    expect(refused.status).toBe('warning');
    expect(refused.problems).toMatchObject([
      { kind: 'model_not_offered', model: 'm' },
      { kind: 'effort_not_offered' },
    ]);
  });
});

describe('memberHealthOf — MCP', () => {
  const servers = [
    { name: 'broken', status: 'failed' as const },
    { name: 'figma', status: 'needs_auth' as const },
    { name: 'waiting', status: 'pending' as const },
    { name: 'fine', status: 'connected' as const },
    { name: 'dialling', status: 'loading' as const },
    { name: 'off', status: 'disabled' as const },
  ];

  it('maps failed, needs_auth, pending and CLI-disabled servers to amber problems naming the server', () => {
    const health = memberHealthOf(
      'a',
      facts(configuration({ mcp: { servers, checking: false } })),
    );

    expect(health.status).toBe('warning');
    expect(
      health.problems.map((entry) => [entry.kind, entry.level, entry.server]),
    ).toEqual([
      ['mcp_failed', 'warning', 'broken'],
      ['mcp_needs_auth', 'warning', 'figma'],
      ['mcp_disconnected', 'warning', 'waiting'],
      ['mcp_disconnected', 'warning', 'off'],
    ]);
  });

  it('skips the servers the member switched off', () => {
    const health = memberHealthOf(
      'a',
      facts(
        configuration({
          mcpDisabled: ['broken', 'figma', 'waiting', 'off'],
          mcp: { servers, checking: false },
        }),
      ),
    );

    expect(health.problems).toEqual([]);
    expect(health.status).toBe('ok');
  });

  it('dates the member by its oldest MCP reading, and by none when no reading is known', () => {
    const dated = memberHealthOf(
      'a',
      facts(
        configuration({
          mcp: {
            servers: [],
            checking: false,
            checkedAt: '2026-11-02T10:00:00.000Z',
          },
        }),
        configuration({
          mcp: {
            servers: [],
            checking: false,
            checkedAt: '2026-11-01T09:00:00.000Z',
          },
        }),
        configuration({ mcp: { servers: null, checking: false } }),
      ),
    );
    const undated = memberHealthOf('a', facts(configuration()));

    expect(dated.mcpCheckedAt).toBe('2026-11-01T09:00:00.000Z');
    expect(undated.mcpCheckedAt).toBeNull();
  });

  it('is checking while a read runs, unless a problem already blocks', () => {
    const checking = memberHealthOf(
      'a',
      facts(configuration({ mcp: { servers: null, checking: true } })),
    );
    const blocked = memberHealthOf(
      'a',
      facts(
        configuration({
          cli: 'missing',
          mcp: { servers: null, checking: true },
        }),
      ),
    );

    expect(checking.status).toBe('checking');
    expect(blocked.status).toBe('error');
    expect([checking.checking, blocked.checking]).toEqual([true, true]);
  });
});

describe('teamProblemsOf', () => {
  it('flags a trigger naming no existing member as blocking', () => {
    const team = teamOf([member('a')], {
      triggers: [{ kind: 'first-message', member: 'ghost' }],
    });

    expect(teamProblemsOf(team)).toMatchObject([
      { kind: 'no_trigger', level: 'error', agent: null },
    ]);
  });

  it('warns about a stage whose responsible member no longer exists', () => {
    const stage: TeamStage = {
      id: 'build',
      title: 'Build',
      goal: 'built',
      responsible: ['a', 'removed'],
    };
    const team = teamOf([member('a')], { stages: [stage] });

    const problems = teamProblemsOf(team);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      kind: 'stage_member_missing',
      level: 'warning',
    });
    expect(problems[0]?.message).toContain('removed');
  });
});

describe('healthOf and blockingProblemsOf', () => {
  const team = teamOf([member('a'), member('b')]);
  const all = new Map<string, MemberFacts>([
    ['a', facts(configuration({ cli: 'missing' }))],
    [
      'b',
      facts(
        configuration({
          mcp: { servers: [{ name: 's', status: 'failed' }], checking: false },
        }),
      ),
    ],
  ]);

  it('is blocking when any member is in error and lists every member', () => {
    const health = healthOf(team, 'team', all, '2026-01-01T00:00:00.000Z');

    expect(health.blocking).toBe(true);
    expect(
      health.members.map((entry) => [entry.memberId, entry.status]),
    ).toEqual([
      ['a', 'error'],
      ['b', 'warning'],
    ]);
  });

  it('is not blocking for amber problems alone', () => {
    const amber = new Map<string, MemberFacts>([
      ['b', all.get('b') as MemberFacts],
    ]);

    expect(
      healthOf(team, 'team', amber, '2026-01-01T00:00:00.000Z').blocking,
    ).toBe(false);
    expect(blockingProblemsOf(team, amber)).toEqual([]);
  });

  it('returns only the red problems, each led by its member’s name', () => {
    expect(
      blockingProblemsOf(team, all).map((entry) => [entry.kind, entry.message]),
    ).toEqual([
      [
        'cli_missing',
        'a: Claude Code is not installed, so this member cannot run.',
      ],
    ]);
  });
});
