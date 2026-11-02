import { describe, expect, it, vi } from 'vitest';

import type { MemberProblem } from './member-problems';
import { memberProblemsOf } from './member-problems';
import { groupMemberFindings } from './team-problems';

const MEMBERS = ['manager', 'senior', 'qa'].map((id) => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
}));

const SERVERS = ['Rebrandly', 'Luma', 'Miro', 'Asana'];

function needsAuth(memberId: string, configDir: string | null = null) {
  return memberProblemsOf(
    memberId,
    {
      memberId,
      status: 'warning',
      seats: [],
      problems: SERVERS.map((server) => ({
        kind: 'mcp_needs_auth' as const,
        level: 'warning' as const,
        message: `MCP server "${server}" needs signing in for this member.`,
        agent: 'claude' as const,
        configDir,
        server,
        poolMember: null,
      })),
    } as unknown as Parameters<typeof memberProblemsOf>[1],
    [],
  );
}

const label = (agent: string): string =>
  agent === 'claude' ? 'Claude Code' : agent;

function group(
  findings: { memberId: string; problems: MemberProblem[] }[],
  fixOf = vi.fn((problem: MemberProblem) => ({
    label: problem.server === null ? 'Open MCP' : 'Sign in',
    run: () => undefined,
  })),
) {
  return {
    rows: groupMemberFindings(
      findings.flatMap(({ memberId, problems }) =>
        problems.map((problem) => ({
          member: MEMBERS.find((member) => member.id === memberId)!,
          problem,
        })),
      ),
      label,
      fixOf,
    ),
    fixOf,
  };
}

describe('groupMemberFindings', () => {
  it('makes one row of the servers one account lacks, naming every member it reaches', () => {
    const { rows, fixOf } = group(
      MEMBERS.map((member) => ({
        memberId: member.id,
        problems: needsAuth(member.id),
      })),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      message: '4 MCP servers need signing in.',
      account: 'Claude Code · default profile',
      details: SERVERS,
      fix: { label: 'Open MCP' },
    });
    expect(rows[0]!.members.map((member) => member.id)).toEqual([
      'manager',
      'senior',
      'qa',
    ]);
    expect(fixOf).toHaveBeenCalledWith(
      expect.objectContaining({ server: null }),
    );
  });

  it('keeps two accounts apart', () => {
    const { rows } = group([
      { memberId: 'manager', problems: needsAuth('manager') },
      { memberId: 'qa', problems: needsAuth('qa', '/Users/me/.claude-work') },
    ]);

    expect(rows.map((row) => row.members.map((member) => member.id))).toEqual([
      ['manager'],
      ['qa'],
    ]);
  });

  it('merges the same finding across members and drops "for this member"', () => {
    const signedOut = (memberId: string): MemberProblem[] =>
      memberProblemsOf(memberId, undefined, [
        {
          kind: 'signed_out',
          message: 'Claude Code is signed out for this member.',
          agent: 'claude',
          configDir: null,
          poolMember: null,
        },
      ]);
    const { rows } = group([
      { memberId: 'manager', problems: signedOut('manager') },
      { memberId: 'senior', problems: signedOut('senior') },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toBe('Claude Code is signed out.');
    expect(rows[0]!.details).toBeUndefined();
  });

  it('puts what stops a run first', () => {
    const { rows } = group([
      { memberId: 'manager', problems: needsAuth('manager') },
      {
        memberId: 'qa',
        problems: [
          {
            key: 'qa:cli',
            memberId: 'qa',
            kind: 'cli_missing',
            level: 'error',
            message: 'codex is not installed.',
            agent: 'codex',
            configDir: null,
            server: null,
            servers: [],
            poolMember: null,
          },
        ],
      },
    ]);

    expect(rows.map((row) => row.level)).toEqual(['error', 'warning']);
  });
});
