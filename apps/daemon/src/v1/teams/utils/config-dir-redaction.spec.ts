import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../__tests__/team-builders';
import type { Team, TeamMember } from '../teams.types';
import {
  configDirToken,
  firstLineOf,
  redactConfigDirs,
  redactConfigDirText,
  restoreConfigDirs,
} from './config-dir-redaction';

const WORK = '/Users/me/.claude-work';
const SPARE = '/Users/me/.claude-spare';
const CODEX = '/Users/me/.codex-b';

const CURRENT: Team = teamOf([
  member('coder', {
    approval: 'ask',
    configDir: WORK,
    pool: [
      { agent: 'claude', configDir: SPARE },
      { agent: 'codex', configDir: CODEX },
    ],
  }),
]);

const coderOf = (team: Team): TeamMember => team.members[0]!;

function proposing(overrides: Partial<TeamMember>): Team {
  return { ...CURRENT, members: [{ ...coderOf(CURRENT), ...overrides }] };
}

describe('config-dir redaction', () => {
  it('shows every agent and pool-member profile as the token naming its path', () => {
    const shown = redactConfigDirs(CURRENT);

    expect(JSON.stringify(shown)).not.toContain('/Users/me');
    expect(coderOf(shown)).toMatchObject({
      configDir: configDirToken(WORK),
      pool: [
        { configDir: configDirToken(SPARE) },
        { configDir: configDirToken(CODEX) },
      ],
    });
    expect(configDirToken(WORK)).toMatch(/^<set:[0-9a-f]{8}>$/);
    expect(configDirToken(WORK)).not.toBe(configDirToken(SPARE));
  });

  it('puts every real path back where a replacement kept its token', () => {
    expect(restoreConfigDirs(redactConfigDirs(CURRENT), CURRENT)).toEqual({
      ok: true,
      team: CURRENT,
    });
  });

  it('follows a token wherever the edit moved its agent', () => {
    // The spare claude account promoted to the member, the member's own moved into
    // the pool, the codex member dropped: positions all changed.
    const promoted = proposing({
      configDir: configDirToken(SPARE),
      pool: [{ agent: 'claude', configDir: configDirToken(WORK) }],
    });

    const restored = restoreConfigDirs(promoted, CURRENT);

    expect(restored).toMatchObject({
      ok: true,
      team: {
        members: [{ configDir: SPARE, pool: [{ configDir: WORK }] }],
      },
    });
  });

  it('refuses a token moved onto an agent of another CLI', () => {
    const switched = proposing({
      agent: 'codex',
      configDir: configDirToken(WORK),
      pool: undefined,
    });

    expect(restoreConfigDirs(switched, CURRENT)).toEqual({
      ok: false,
      message: expect.stringContaining('this agent runs codex'),
    });
  });

  it('refuses a token in a new team, which replaces none', () => {
    const copied = redactConfigDirs(CURRENT);

    expect(restoreConfigDirs(copied, null)).toEqual({
      ok: false,
      message: expect.stringContaining('a new team replaces none'),
    });
  });

  it('refuses a token the replaced team does not name', () => {
    const unknown = proposing({ configDir: '<set>', pool: undefined });

    expect(restoreConfigDirs(unknown, CURRENT)).toEqual({
      ok: false,
      message: expect.stringContaining('names no profile'),
    });
  });

  it('leaves a profile the agent named itself as it is', () => {
    const named = proposing({ configDir: '/Users/me/.other' });

    expect(restoreConfigDirs(named, CURRENT)).toMatchObject({
      ok: true,
      team: { members: [{ configDir: '/Users/me/.other' }] },
    });
  });

  it('shows each path of a refusal as its token', () => {
    expect(
      redactConfigDirText(`Config directory does not exist: ${SPARE}`, CURRENT),
    ).toBe(`Config directory does not exist: ${configDirToken(SPARE)}`);
  });

  it("keeps only a YAML error's first line, never the file lines it quotes", () => {
    const message =
      'A block sequence may not be used as an implicit map key at line 5, column 1:\n\n    configDir: /Users/u/.claude-work\n- bad: 1\n^\n';

    expect(firstLineOf(message)).toBe(
      'A block sequence may not be used as an implicit map key at line 5, column 1',
    );
  });
});
