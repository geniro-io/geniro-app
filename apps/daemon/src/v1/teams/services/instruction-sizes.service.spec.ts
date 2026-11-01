import { describe, expect, it } from 'vitest';

import { freshVocabularyStore } from '../../agents/adapters/__tests__/fresh-vocabulary-store';
import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import { CodexAdapter } from '../../agents/adapters/codex/codex.adapter';
import { CursorAcpAdapter } from '../../agents/adapters/cursor-acp/cursor-acp.adapter';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import {
  GENIRO_UI_PREAMBLE,
  joinTurnInstructionParts,
  turnInstructionParts,
} from '../../agents/utils/agent-instructions';
import { member, teamOf } from '../__tests__/team-builders';
import type { Team } from '../teams.types';
import { ANSWERING_A_CALL } from '../utils/callee-text';
import { callSurfaceText } from '../utils/member-instructions';
import { stageMapPrompt } from '../utils/stage-text';
import { InstructionSizesService } from './instruction-sizes.service';

const claude = new ClaudeAdapter();
const codex = new CodexAdapter({ clientVersion: '1.0.0' });
const subject = new InstructionSizesService(
  new AgentAdapterRegistry([
    claude,
    new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore() }),
    codex,
  ]),
);

const manager = member('manager', {
  name: 'Manager',
  instructions: 'You run the team.\n',
  character: ' Calm and brief. ',
});
const reviewer = member('reviewer', {
  name: 'Reviewer',
  agent: 'codex',
  role: 'Reviews a diff.',
  instructions: 'Review carefully.',
});

/** The Dev Team's shape: a manager that handles the first message, a reviewer that only answers calls. */
const DEV_TEAM: Pick<
  Team,
  'members' | 'triggers' | 'instructionBlocks' | 'stages'
> = teamOf([manager, reviewer], {
  instructionBlocks: [
    {
      id: 'settings',
      title: 'Settings',
      text: 'TEAM SETTINGS',
      audience: 'everyone',
    },
    {
      id: 'intent',
      title: 'Intent',
      text: 'INTENT STANDARD',
      audience: ['manager'],
    },
  ],
});

const SETTINGS = { customInstructions: 'MINE', replyLanguage: 'Russian' };

function sizeOf(memberId: string) {
  const size = subject
    .measure({ team: DEV_TEAM, ...SETTINGS })
    .members.find((entry) => entry.memberId === memberId);
  if (!size) {
    throw new Error(`no size for ${memberId}`);
  }
  return size;
}

describe('InstructionSizesService', () => {
  it('measures the Manager’s whole block — the length its own CLI is handed', () => {
    const expected = joinTurnInstructionParts(
      turnInstructionParts({
        backgroundWorkNote: claude.getConfig().backgroundWork.agentNote,
        replyLanguage: 'Russian',
        customInstructions: 'MINE',
        instructionBlocks: 'TEAM SETTINGS\n\nINTENT STANDARD',
        systemPrompt: manager.instructions,
        characterPrompt: manager.character,
        callSurfacePrompt: callSurfaceText(
          [reviewer],
          claude.getConfig().questionToolName,
          false,
        ),
      }),
    );

    const size = sizeOf('manager');

    expect(size.totalChars).toBe(expected.length);
    expect(size.approxTokens).toBe(Math.ceil(expected.length / 4));
    expect(size).toMatchObject({ agent: 'claude', turn: 'own' });
  });

  it('breaks it down by source, one row per block, adding up to the total', () => {
    const size = sizeOf('manager');

    expect(size.parts.map((part) => [part.source, part.blockId])).toEqual([
      ['preamble', undefined],
      ['backgroundWorkNote', undefined],
      ['replyLanguage', undefined],
      ['customInstructions', undefined],
      ['instructionBlocks', 'settings'],
      ['instructionBlocks', 'intent'],
      ['instructions', undefined],
      ['character', undefined],
      ['callSurface', undefined],
    ]);
    expect(size.parts[0]?.chars).toBe(GENIRO_UI_PREAMBLE.length);
    expect(size.parts[4]).toMatchObject({
      chars: 'TEAM SETTINGS'.length,
      approxTokens: Math.ceil('TEAM SETTINGS'.length / 4),
    });
    // Instructions and character are measured as sent: trimmed.
    expect(size.parts[6]?.chars).toBe('You run the team.'.length);
    expect(size.parts[7]?.chars).toBe('Calm and brief.'.length);
    // Eight breaks between the nine rows, two characters each.
    expect(size.separatorChars).toBe(16);
    expect(
      size.parts.reduce((sum, part) => sum + part.chars, 0) +
        size.separatorChars,
    ).toBe(size.totalChars);
  });

  it('gives each member only the blocks addressed to it', () => {
    const blockRows = (memberId: string) =>
      sizeOf(memberId)
        .parts.filter((part) => part.source === 'instructionBlocks')
        .map((part) => part.blockId);

    expect(blockRows('manager')).toEqual(['settings', 'intent']);
    expect(blockRows('reviewer')).toEqual(['settings']);
  });

  it('measures a member only ever called as a turn answering a call, on its own CLI', () => {
    const size = sizeOf('reviewer');

    expect(size).toMatchObject({ agent: 'codex', turn: 'call' });
    expect(size.parts.map((part) => part.source)).toEqual([
      'preamble',
      'backgroundWorkNote',
      'replyLanguage',
      'customInstructions',
      'instructionBlocks',
      'instructions',
      'answeringACall',
      'callSurface',
    ]);
    expect(size.parts.find((p) => p.source === 'answeringACall')?.chars).toBe(
      ANSWERING_A_CALL.length,
    );
    expect(size.parts[1]?.chars).toBe(
      codex.getConfig().backgroundWork.agentNote?.trim().length,
    );
  });

  it('leaves out the settings the user has not set', () => {
    const size = subject
      .measure({ team: DEV_TEAM })
      .members.find((entry) => entry.memberId === 'manager');

    expect(size?.parts.map((part) => part.source)).not.toContain(
      'customInstructions',
    );
    expect(size?.parts.map((part) => part.source)).not.toContain(
      'replyLanguage',
    );
  });

  it("measures the run's stage map for every member, between the blocks and the role", () => {
    const stages: NonNullable<Team['stages']> = [
      { id: 'build', title: 'Build', goal: 'built', next: ['review'] },
      {
        id: 'review',
        title: 'Review',
        goal: 'approved',
        responsible: ['reviewer'],
      },
    ];
    const sizes = subject.measure({
      team: { ...DEV_TEAM, stages },
      ...SETTINGS,
    }).members;
    const map = stageMapPrompt(stages, DEV_TEAM.members);
    expect(map).toContain(
      '2. Review (review) — final stage — responsible: Reviewer',
    );
    expect(sizes).toHaveLength(2);
    for (const size of sizes) {
      const sources = size.parts.map((part) => part.source);
      expect(sources).toContain('stageMap');
      expect(sources.indexOf('stageMap')).toBe(
        sources.indexOf('instructions') - 1,
      );
      expect(size.parts.find((p) => p.source === 'stageMap')?.chars).toBe(
        map.length,
      );
    }
    expect(
      subject
        .measure({ team: DEV_TEAM, ...SETTINGS })
        .members.flatMap((m) => m.parts.map((p) => p.source)),
    ).not.toContain('stageMap');
  });

  it('answers for every member of the team, in the team’s order', () => {
    expect(
      subject
        .measure({ team: DEV_TEAM, ...SETTINGS })
        .members.map((entry) => entry.memberId),
    ).toEqual(['manager', 'reviewer']);
  });
});
