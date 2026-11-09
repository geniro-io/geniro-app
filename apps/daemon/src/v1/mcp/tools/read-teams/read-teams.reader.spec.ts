import { describe, expect, it } from 'vitest';

import { PAGE_BYTES } from '../../../agents/services/thread-reader.service';
import { member, teamOf } from '../../../teams/__tests__/team-builders';
import { configDirToken } from '../../../teams/utils/config-dir-redaction';
import {
  readReadTeamsArgs,
  TEAM_RESULT_PREFACE,
  teamListText,
  teamOrOutlineText,
  teamOverlaysText,
  teamProjectsText,
  teamReadOf,
  teamReadText,
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
        memberCount: 3,
        stageCount: 2,
        agentCounts: [{ kind: 'claude', count: 2 }],
        portrait: [
          {
            id: 'lead',
            name: 'Lead',
            avatar: { kind: 'emoji', value: '🦊' },
          },
        ],
        updatedAt: '2026-10-20T10:00:00.000Z',
      },
    ]);

    expect(bodyOf(text)).toEqual([
      {
        slug: 'team',
        name: 'Team',
        description: null,
        members: 3,
        stages: 2,
        agents: [{ kind: 'claude', count: 2 }],
      },
    ]);
    expect(teamListText([])).toBe('The team library is empty.');
  });

  it("never shows an agent's profile path", () => {
    const team = teamOf([
      member('a', { approval: 'ask', configDir: '/Users/me/.claude-work' }),
    ]);

    const text = teamText({ slug: 'team', hash: 'h1', team });
    expect(text).not.toContain('/Users/me');
    expect(text).toContain(
      `"configDir": "${configDirToken('/Users/me/.claude-work')}"`,
    );
  });

  it('answers one team with the hash it was read at', () => {
    const team = teamOf([member('a')], { name: 'Team' });
    expect(bodyOf(teamText({ slug: 'team', hash: 'h1', team }))).toEqual({
      slug: 'team',
      hash: 'h1',
      team,
    });
  });
});

describe('teamReadOf', () => {
  const read = (args: Record<string, unknown>) => {
    const parsed = readReadTeamsArgs(args);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return teamReadOf(parsed.query);
  };

  it('names the one read the arguments ask for', () => {
    expect(read({ slug: 't' })).toEqual({ kind: 'team' });
    expect(read({ slug: 't', members: ['a'], stages: true })).toEqual({
      kind: 'parts',
      selection: { members: ['a'], stages: true },
      offset: 0,
    });
    expect(read({ slug: 't', search: ['x'], offset: 40 })).toEqual({
      kind: 'search',
      terms: ['x'],
      offset: 40,
    });
    expect(read({ slug: 't', full: true })).toEqual({
      kind: 'full',
      offset: 0,
    });
    expect(read({ slug: 't', overlays: true })).toEqual({
      kind: 'overlays',
      offset: 0,
    });
    expect(read({ slug: 't', projects: true, offset: 5 })).toEqual({
      kind: 'projects',
      offset: 5,
    });
  });

  it('refuses two reads at once and an offset with nothing to page', () => {
    expect(read({ slug: 't', members: ['a'], search: ['x'] })).toMatch(
      /^Not read: ask for one read at a time — members\/blocks\/stages, search/,
    );
    expect(read({ slug: 't', offset: 10 })).toMatch(/^Not read: `offset`/);
    expect(readReadTeamsArgs({ slug: 't', members: [] }).ok).toBe(false);
  });
});

describe('reading a large team', () => {
  const PROFILE = '/Users/me/.claude-work';
  const big = teamOf(
    [
      member('lead', {
        configDir: PROFILE,
        instructions: Array.from(
          { length: 900 },
          (_, i) => `Rule ${i}: keep line ${i} as it is.`,
        ).join('\n'),
      }),
      member('helper', { role: 'Helps.' }),
    ],
    { name: 'Big' },
  );
  const wire = { slug: 'big', hash: 'h9', team: big };

  it('answers a small team whole and a large one as its outline', () => {
    const small = teamOf([member('a')], { name: 'Small' });
    expect(teamOrOutlineText({ slug: 's', hash: 'h1', team: small })).toBe(
      teamText({ slug: 's', hash: 'h1', team: small }),
    );

    const outline = bodyOf(teamOrOutlineText(wire)) as {
      hash: string;
      note: string;
      outline: { members: { id: string; instructions: string }[] };
    };
    expect(outline.hash).toBe('h9');
    expect(outline.note).toContain('past one answer');
    expect(outline.outline.members[0]!.instructions).toMatch(
      /^⟨\d+ characters — read with members=\["lead"\]⟩$/,
    );
    expect(JSON.stringify(outline)).not.toContain(PROFILE);
  });

  it('pages a long part so the pages join back into the whole, each under a page, cut at a line break', () => {
    const pages: string[] = [];
    let offset = 0;
    for (let page = 0; page < 20; page += 1) {
      const text = teamReadText(wire, {
        kind: 'parts',
        selection: { members: ['lead'] },
        offset,
      });
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(PAGE_BYTES);
      expect(text).toContain('Team `big` at hash h9');
      const body = text.slice(text.indexOf('\n\n') + 2);
      pages.push(body);
      const next = /the same call with offset (\d+)/.exec(text);
      if (next === null) {
        expect(text).toContain('the last page');
        break;
      }
      expect(body.endsWith('\n')).toBe(true);
      offset = Number(next[1]);
    }
    expect(pages.length).toBeGreaterThan(1);
    const joined = pages.join('');
    expect(joined).toContain('Rule 0: keep line 0 as it is.');
    expect(joined).toContain('Rule 899: keep line 899 as it is.');
    expect(joined).toContain(`"configDir":"${configDirToken(PROFILE)}"`);
    expect(joined).not.toContain(PROFILE);
  });

  it('caps a search word, and still ends a page whose lead runs past the page', () => {
    expect(readReadTeamsArgs({ slug: 't', search: ['x'.repeat(201)] }).ok).toBe(
      false,
    );
    const text = teamReadText(wire, {
      kind: 'search',
      terms: ['line 42 ', 'y'.repeat(30_000)],
      offset: 0,
    });
    expect(text).toContain('Rule 42: keep line 42 as it is.');
  });

  it('answers a search with its count, and names ids the team lacks', () => {
    expect(
      teamReadText(wire, { kind: 'search', terms: ['line 42 '], offset: 0 }),
    ).toContain('search for "line 42 ": 1 paragraphs in 1 fields');
    expect(
      teamReadText(wire, { kind: 'search', terms: ['absent'], offset: 0 }),
    ).toContain('no paragraph of its texts holds "absent"');
    expect(
      teamReadText(wire, {
        kind: 'parts',
        selection: { members: ['ghost'] },
        offset: 0,
      }),
    ).toMatch(/^Not read: the team `big` has no member ghost/);
  });

  it('writes out each project that runs the team with its revision, size and blocks', () => {
    const text = teamProjectsText(
      wire,
      [
        {
          id: 'p1',
          name: 'Billing',
          instructionsRevision: 4,
          instructionBlocks: [
            { id: 'repo', title: 'Repo', text: 'Use pnpm.' },
            { id: 'tests', title: 'Tests', text: 'Run pnpm test.' },
          ],
        },
      ],
      0,
    );
    expect(text).toContain(
      '=== project Billing (p1) · instructionsRevision 4 · 25 of 20000 characters ===',
    );
    expect(text).toContain(
      '--- block repo · title "Repo" · 9 characters ---\nUse pnpm.',
    );
    expect(teamProjectsText(wire, [], 0)).toContain(
      'No project runs the team `big` by default.',
    );
  });

  it('shows every overlay with its profile paths as tokens', () => {
    const text = teamOverlaysText(
      wire,
      [
        {
          projectId: 'p1',
          projectName: 'Billing',
          active: true,
          source: `# moved from ${PROFILE}\nmembers:\n  lead:\n    settings:\n      configDir: ${PROFILE} # was ${PROFILE}\n`,
        },
        { projectId: 'p2', projectName: 'Docs', active: false, source: null },
      ],
      0,
    );
    expect(text).toContain('=== overlay Billing (p1) · its runs apply it ===');
    expect(text).toContain(`configDir: ${configDirToken(PROFILE)}`);
    expect(text).not.toContain(PROFILE);
    expect(text).toContain('(the file cannot be read)');
    expect(teamOverlaysText(wire, [], 0)).toContain(
      'No project has an overlay',
    );
    expect(text).toContain('2 project overlays.');
    expect(text).not.toContain('read-only');
  });
});
