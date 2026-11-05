import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../__tests__/team-builders';
import { applyTeamEdits } from './team-edits';
import { teamOutline, teamPartsText, teamSearchText } from './team-reading';

const LONG =
  'Open the pull request.\n\nAttach two screenshots to it, one per visible change.\n\nReport in one message.';

const TEAM = teamOf(
  [
    member('manager', {
      role: 'Runs the work.',
      instructions: LONG,
      model: 'opus',
    }),
    member('middle', {
      role: 'Builds small changes.',
      instructions: 'Build it.\n\nPublish the screenshots when asked.',
    }),
  ],
  {
    name: 'Dev Team',
    instructionBlocks: [
      {
        id: 'settings',
        title: 'Team Settings',
        text: 'Screenshot budget: 3.\nVisuals: none.',
        audience: 'everyone',
      },
    ],
    stages: [
      {
        id: 'build',
        title: 'Build',
        goal: 'The change is pushed.',
        responsible: ['manager'],
      },
    ],
  },
);

describe('teamOutline', () => {
  it('keeps short fields and replaces each text by its size and the read that answers it', () => {
    const outline = teamOutline(TEAM);

    expect(outline).toMatchObject({
      name: 'Dev Team',
      mode: 'lead',
      members: [
        {
          id: 'manager',
          role: 'Runs the work.',
          model: 'opus',
          instructions: `⟨${LONG.length} characters — read with members=["manager"]⟩`,
        },
        { id: 'middle' },
      ],
      instructionBlocks: [
        {
          id: 'settings',
          title: 'Team Settings',
          audience: 'everyone',
          text: expect.stringMatching(
            /^⟨\d+ characters — read with blocks=\["settings"\]⟩$/,
          ),
        },
      ],
      stages: [{ id: 'build', goal: 'The change is pushed.' }],
    });
    expect(JSON.stringify(outline)).not.toContain('Attach two screenshots');
  });
});

describe('teamPartsText', () => {
  it('writes each text of a part between markers naming the path an edit takes', () => {
    const parts = teamPartsText(TEAM, { members: ['manager'] });
    if (!parts.ok) {
      throw new Error('expected the part');
    }

    expect(parts.text).toContain('## members/manager');
    expect(parts.text).toContain(
      `=== members/manager/instructions · ${LONG.length} characters ===\n${LONG}\n=== end members/manager/instructions ===`,
    );
    expect(parts.text).not.toContain('members/middle');
    const between = parts.text.split('=== members/manager/instructions')[1]!;
    const copied = between
      .slice(between.indexOf('\n') + 1)
      .split('\n=== end')[0]!;
    expect(
      applyTeamEdits(
        TEAM,
        [
          {
            path: 'members/manager/instructions',
            find: copied.split('\n\n')[1]!,
            replace: 'Attach nothing.',
          },
        ],
        'read_teams',
      ),
    ).toMatchObject({ ok: true, landed: ['members/manager/instructions'] });
  });

  it('reads blocks and stages by request, everything with all, and names ids the team lacks', () => {
    const blocks = teamPartsText(TEAM, { blocks: ['settings'], stages: true });
    expect(blocks).toMatchObject({ ok: true });
    expect(blocks.ok && blocks.text).toMatch(
      /## instructionBlocks\/settings[\s\S]*## stages\/build/,
    );

    const described = { ...TEAM, description: `Builds.\n\n${LONG}` };
    const whole = teamPartsText(described, 'all');
    expect(whole.ok && whole.text).toContain(
      `=== description · ${described.description.length} characters ===`,
    );
    expect(
      applyTeamEdits(
        described,
        [{ path: 'description', find: 'Builds.', replace: 'Ships.' }],
        'read_teams',
      ),
    ).toMatchObject({ ok: true, landed: ['description'] });

    const all = teamPartsText(TEAM, 'all');
    expect(all.ok && all.text).toMatch(
      /^## team[\s\S]*## members\/manager[\s\S]*## members\/middle[\s\S]*## instructionBlocks\/settings[\s\S]*## stages\/build/,
    );

    expect(
      teamPartsText(TEAM, { members: ['ghost'], blocks: ['nope'] }),
    ).toEqual({ ok: false, unknown: ['member ghost', 'block nope'] });
    expect(teamPartsText(teamOf([member('a')]), { stages: true })).toEqual({
      ok: true,
      text: 'The team has no stages.',
    });
  });
});

describe('teamSearchText', () => {
  it('answers every paragraph holding a term, ignoring case, under the path of its field', () => {
    const found = teamSearchText(TEAM, ['SCREENSHOT', 'visuals']);

    expect(found).toMatchObject({ paragraphs: 3, fields: 3 });
    expect(found.text).toContain(
      '=== members/manager/instructions · 1 of 3 paragraphs ===\nAttach two screenshots to it, one per visible change.\n=== end members/manager/instructions ===',
    );
    expect(found.text).toContain(
      '=== members/middle/instructions · 1 of 2 paragraphs ===',
    );
    expect(found.text).toContain(
      '=== instructionBlocks/settings/text · 1 of 1 paragraphs ===',
    );
    expect(found.text).not.toContain('Report in one message.');
    expect(teamSearchText(TEAM, ['absent'])).toEqual({
      text: '',
      paragraphs: 0,
      fields: 0,
    });
  });

  it('cuts a long paragraph around its first match and marks the cut', () => {
    const long = `${'a'.repeat(3_000)} needle ${'b'.repeat(3_000)}`;
    const found = teamSearchText(
      teamOf([member('m', { instructions: long })]),
      ['needle'],
    );

    const paragraph = found.text.split('\n')[1]!;
    expect(paragraph.startsWith('…')).toBe(true);
    expect(paragraph.endsWith('…')).toBe(true);
    expect(paragraph).toContain('needle');
    expect(paragraph.length).toBeLessThan(1_600);
  });
});
