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
import type { Workflow, WorkflowAgentNode } from '../graphs.types';
import { ANSWERING_A_CALL } from '../utils/callee-text';
import { callSurfaceText } from '../utils/node-instructions';
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

const manager = {
  id: 'manager',
  name: 'Manager',
  kind: 'agent',
  agent: 'claude',
  approval: 'auto',
  role: 'You run the team.\n',
} as WorkflowAgentNode;
const reviewer = {
  id: 'reviewer',
  kind: 'agent',
  agent: 'codex',
  approval: 'auto',
  description: 'Reviews a diff.',
  role: 'Review carefully.',
} as WorkflowAgentNode;

/** The Dev Team's shape: a trigger-fed manager with blocks, a call-only callee. */
const DEV_TEAM: Pick<Workflow, 'nodes' | 'edges' | 'stages'> = {
  nodes: [
    { id: 'trigger', kind: 'trigger', trigger: 'manual' },
    { id: 'settings', kind: 'instruction', instructions: 'TEAM SETTINGS' },
    { id: 'intent', kind: 'instruction', instructions: 'INTENT STANDARD' },
    manager,
    reviewer,
  ] as Workflow['nodes'],
  edges: [
    { from: 'trigger', to: 'manager', kind: 'data' },
    { from: 'settings', to: 'manager', kind: 'instruction' },
    { from: 'intent', to: 'manager', kind: 'instruction' },
    { from: 'settings', to: 'reviewer', kind: 'instruction' },
    { from: 'manager', to: 'reviewer', kind: 'call' },
  ],
};

const SETTINGS = { customInstructions: 'MINE', replyLanguage: 'Russian' };

function sizeOf(nodeId: string) {
  const size = subject
    .measure({ workflow: DEV_TEAM, ...SETTINGS })
    .nodes.find((node) => node.nodeId === nodeId);
  if (!size) {
    throw new Error(`no size for ${nodeId}`);
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
        systemPrompt: manager.role,
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

  it('breaks it down by source, one row per wired block, adding up to the total', () => {
    const size = sizeOf('manager');

    expect(
      size.parts.map((part) => [part.source, part.instructionNodeId]),
    ).toEqual([
      ['preamble', undefined],
      ['backgroundWorkNote', undefined],
      ['replyLanguage', undefined],
      ['customInstructions', undefined],
      ['instructionBlocks', 'settings'],
      ['instructionBlocks', 'intent'],
      ['role', undefined],
      ['callSurface', undefined],
    ]);
    expect(size.parts[0]?.chars).toBe(GENIRO_UI_PREAMBLE.length);
    expect(size.parts[4]).toMatchObject({
      chars: 'TEAM SETTINGS'.length,
      approxTokens: Math.ceil('TEAM SETTINGS'.length / 4),
    });
    // The role is measured as sent: trimmed.
    expect(size.parts[6]?.chars).toBe('You run the team.'.length);
    // Seven breaks between the eight rows, two characters each.
    expect(size.separatorChars).toBe(14);
    expect(
      size.parts.reduce((sum, part) => sum + part.chars, 0) +
        size.separatorChars,
    ).toBe(size.totalChars);
  });

  it('measures a node only ever called as a turn answering a call, on its own CLI', () => {
    const size = sizeOf('reviewer');

    expect(size).toMatchObject({ agent: 'codex', turn: 'call' });
    expect(size.parts.map((part) => part.source)).toEqual([
      'preamble',
      'backgroundWorkNote',
      'replyLanguage',
      'customInstructions',
      'instructionBlocks',
      'role',
      'answeringACall',
    ]);
    expect(size.parts.at(-1)?.chars).toBe(ANSWERING_A_CALL.length);
    expect(size.parts[1]?.chars).toBe(
      codex.getConfig().backgroundWork.agentNote?.trim().length,
    );
  });

  it('leaves out the settings the user has not set', () => {
    const size = subject
      .measure({ workflow: DEV_TEAM })
      .nodes.find((node) => node.nodeId === 'manager');

    expect(size?.parts.map((part) => part.source)).not.toContain(
      'customInstructions',
    );
    expect(size?.parts.map((part) => part.source)).not.toContain(
      'replyLanguage',
    );
  });

  it("measures the run's stage map for every agent, between the wired blocks and the role", () => {
    const stages: NonNullable<Workflow['stages']> = [
      { id: 'build', title: 'Build', doneWhen: 'built', next: ['review'] },
      {
        id: 'review',
        title: 'Review',
        doneWhen: 'approved',
        ownerHint: 'reviewer',
      },
    ];
    const sizes = subject.measure({
      workflow: { ...DEV_TEAM, stages },
      ...SETTINGS,
    }).nodes;
    const map = stageMapPrompt(stages, DEV_TEAM.nodes);
    for (const size of sizes) {
      const sources = size.parts.map((part) => part.source);
      expect(sources).toContain('stageMap');
      expect(sources.indexOf('stageMap')).toBe(sources.indexOf('role') - 1);
      expect(size.parts.find((p) => p.source === 'stageMap')?.chars).toBe(
        map.length,
      );
    }
    expect(
      subject
        .measure({ workflow: DEV_TEAM, ...SETTINGS })
        .nodes.flatMap((n) => n.parts.map((p) => p.source)),
    ).not.toContain('stageMap');
  });

  it('answers only for agent nodes', () => {
    expect(
      subject
        .measure({ workflow: DEV_TEAM, ...SETTINGS })
        .nodes.map((node) => node.nodeId),
    ).toEqual(['manager', 'reviewer']);
  });
});
