import { describe, expect, it } from 'vitest';

import { configDirToken } from '../../../teams/utils/config-dir-redaction';
import {
  readReadTeamsArgs,
  TEAM_RESULT_PREFACE,
  teamListText,
  teamText,
} from './read-teams.reader';

/** The JSON under the preface every answer leads with. */
function bodyOf(text: string): unknown {
  expect(text.startsWith(`${TEAM_RESULT_PREFACE}\n`)).toBe(true);
  return JSON.parse(text.slice(TEAM_RESULT_PREFACE.length + 1));
}

describe('readReadTeamsArgs', () => {
  it('reads no argument as a listing and a slug as one team', () => {
    expect(readReadTeamsArgs({})).toEqual({ ok: true, query: {} });
    expect(readReadTeamsArgs({ slug: null })).toEqual({
      ok: true,
      query: {},
    });
    expect(readReadTeamsArgs({ slug: 'team' })).toEqual({
      ok: true,
      query: { slug: 'team' },
    });
  });

  it('refuses a misspelt argument rather than listing everything', () => {
    expect(readReadTeamsArgs({ slg: 'team' }).ok).toBe(false);
    expect(readReadTeamsArgs({ slug: '' }).ok).toBe(false);
  });
});

describe('read_teams result text', () => {
  it('lists summaries only, never a definition', () => {
    const text = teamListText([
      {
        slug: 'team',
        name: 'Team',
        description: null,
        nodeCount: 3,
        edgeCount: 2,
        agentCounts: [{ kind: 'claude', count: 2 }],
        updatedAt: '2026-10-20T10:00:00.000Z',
      },
    ]);

    expect(bodyOf(text)).toEqual([
      {
        slug: 'team',
        name: 'Team',
        description: null,
        nodes: 3,
        edges: 2,
        agents: [{ kind: 'claude', count: 2 }],
      },
    ]);
    expect(teamListText([])).toBe('The team library is empty.');
  });

  it("never shows an agent's profile path", () => {
    const team = {
      name: 'Team',
      nodes: [
        {
          id: 'a',
          kind: 'agent' as const,
          agent: 'claude' as const,
          approval: 'ask' as const,
          configDir: '/Users/me/.claude-work',
        },
      ],
      edges: [],
    };

    const text = teamText({ slug: 'team', hash: 'h1', team });
    expect(text).not.toContain('/Users/me');
    expect(text).toContain(
      `"configDir": "${configDirToken('/Users/me/.claude-work')}"`,
    );
  });

  it('answers one team with the hash it was read at', () => {
    const team = { name: 'Team', nodes: [], edges: [] };
    expect(bodyOf(teamText({ slug: 'team', hash: 'h1', team }))).toEqual({
      slug: 'team',
      hash: 'h1',
      team,
    });
  });
});
