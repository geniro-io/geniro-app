import { describe, expect, it } from 'vitest';

import type { AdapterConfig } from '../../agents/adapters/adapter.types';
import { member, teamOf } from '../__tests__/team-builders';
import type { InstructionBlock } from '../teams.types';
import { ANSWERING_WITH_CALLS_OUT } from './callee-text';
import {
  callSurfaceText,
  instructionBlocksByMember,
  joinInstructionBlocks,
  memberInstructionFields,
} from './member-instructions';
import { calleesOf } from './team-roster';

const block = (
  id: string,
  text: string,
  audience: InstructionBlock['audience'],
): InstructionBlock => ({ id, title: id, text, audience });

const TEAM = teamOf(
  [
    member('manager'),
    member('dev', { name: 'Developer', role: 'Writes the code.' }),
  ],
  {
    instructionBlocks: [
      block('standard', '  STANDARD\n', 'everyone'),
      block('blank', '   ', 'everyone'),
      block('team', 'TEAM', ['dev', 'manager']),
      block('ghost', 'GHOST', ['nobody']),
      block('dev-only', 'DEV ONLY', ['dev']),
    ],
  },
);

describe('instructionBlocksByMember', () => {
  it('gives each member the blocks addressed to it, in the team’s block order, trimmed', () => {
    const blocks = instructionBlocksByMember(TEAM);

    expect(blocks.get('manager')).toEqual([
      { blockId: 'standard', text: 'STANDARD' },
      { blockId: 'team', text: 'TEAM' },
    ]);
    expect(blocks.get('dev')).toEqual([
      { blockId: 'standard', text: 'STANDARD' },
      { blockId: 'team', text: 'TEAM' },
      { blockId: 'dev-only', text: 'DEV ONLY' },
    ]);
  });

  it('drops a blank block and reaches nobody with an audience id that names no member', () => {
    const blocks = instructionBlocksByMember(TEAM);
    const delivered = TEAM.members
      .flatMap((m) => blocks.get(m.id) ?? [])
      .map((entry) => entry.blockId);

    expect(delivered).not.toContain('blank');
    expect(delivered).not.toContain('ghost');
  });

  it('delivers a block once to a member listed twice in its audience', () => {
    const blocks = instructionBlocksByMember(
      teamOf([member('a')], {
        instructionBlocks: [block('once', 'ONCE', ['a', 'a'])],
      }),
    );

    expect(blocks.get('a')).toEqual([{ blockId: 'once', text: 'ONCE' }]);
  });

  it('gives a team with no blocks no entry for anyone', () => {
    expect(instructionBlocksByMember(teamOf([member('a')])).size).toBe(0);
  });

  it('joins a member’s blocks as paragraphs, and to null when it has none', () => {
    const blocks = instructionBlocksByMember(TEAM);

    expect(joinInstructionBlocks(blocks.get('manager'))).toBe(
      'STANDARD\n\nTEAM',
    );
    expect(joinInstructionBlocks(blocks.get('absent'))).toBeNull();
  });
});

describe('calleesOf', () => {
  it('lets every member call every other member, never itself', () => {
    const callees = calleesOf(TEAM.members);

    expect(callees.get('manager')?.map((callee) => callee.id)).toEqual(['dev']);
    expect(callees.get('dev')?.map((callee) => callee.id)).toEqual(['manager']);
  });
});

describe('callSurfaceText', () => {
  const dev = member('dev', { name: 'Developer', role: 'Writes the code.' });

  it('names each callee by its role and the caller’s own question tool', () => {
    const text = callSurfaceText([dev], 'AskUserQuestion', false);

    expect(text).toContain('- Developer (agent id: dev) — Writes the code.');
    expect(text).toContain('ask the user with your AskUserQuestion tool');
    expect(text).not.toContain(ANSWERING_WITH_CALLS_OUT);
  });

  it('says the caller cannot escalate when its CLI has no question tool', () => {
    expect(callSurfaceText([dev], null, false)).toContain(
      'you cannot escalate to the user',
    );
  });

  it('adds the calls-out rule only on a turn that answers a call', () => {
    expect(
      callSurfaceText([dev], null, true).endsWith(
        `\n${ANSWERING_WITH_CALLS_OUT}`,
      ),
    ).toBe(true);
  });

  it('lists a callee’s public role but never its instructions or character', () => {
    const text = callSurfaceText(
      [
        member('dev', {
          role: 'Writes the code.',
          instructions: 'PRIVATE-INSTRUCTIONS',
          character: 'PRIVATE-CHARACTER',
        }),
      ],
      null,
      false,
    );

    expect(text).toContain('Writes the code.');
    expect(text).not.toContain('PRIVATE-INSTRUCTIONS');
    expect(text).not.toContain('PRIVATE-CHARACTER');
  });
});

describe('memberInstructionFields', () => {
  const config: Pick<AdapterConfig, 'mcp' | 'questionToolName'> = {
    mcp: { callToolsRequireTrustProbe: false },
    questionToolName: null,
  } as Pick<AdapterConfig, 'mcp' | 'questionToolName'>;

  const manager = member('manager', {
    instructions: 'MANAGER-INSTRUCTIONS',
    character: 'MANAGER-CHARACTER',
  });
  const fieldsOf = (
    overrides: Partial<Parameters<typeof memberInstructionFields>[1]> = {},
  ) =>
    memberInstructionFields(manager, {
      blocks: instructionBlocksByMember(TEAM).get('manager'),
      callees: calleesOf(TEAM.members).get('manager'),
      answeringACall: false,
      config,
      stageMap: null,
      ...overrides,
    });

  it('carries the member’s instructions as the system prompt and its character as the character prompt', () => {
    const fields = fieldsOf();

    expect(fields.systemPrompt).toBe('MANAGER-INSTRUCTIONS');
    expect(fields.characterPrompt).toBe('MANAGER-CHARACTER');
  });

  it('leaves both prompts null for a member that has neither', () => {
    const fields = memberInstructionFields(member('plain'), {
      blocks: undefined,
      callees: undefined,
      answeringACall: false,
      config,
      stageMap: null,
    });

    expect(fields.systemPrompt).toBeNull();
    expect(fields.characterPrompt).toBeNull();
    expect(fields.instructionBlocks).toBeNull();
    expect(fields.callSurfacePrompt).toBeNull();
  });

  it('joins the member’s blocks and lists every other member in the call surface', () => {
    const fields = fieldsOf();

    expect(fields.instructionBlocks).toBe('STANDARD\n\nTEAM');
    expect(fields.callSurfacePrompt).toContain(
      '- Developer (agent id: dev) — Writes the code.',
    );
    expect(fields.callSurfacePrompt).not.toContain('MANAGER-INSTRUCTIONS');
  });

  it('gives no call surface to a member with nobody to call', () => {
    expect(fieldsOf({ callees: [] }).callSurfacePrompt).toBeNull();
  });
});
