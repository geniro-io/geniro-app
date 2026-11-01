import { describe, expect, it } from 'vitest';

import { DEV_TEAM_GRAPH } from '../__tests__/dev-team-graph';
import {
  INSTRUCTION_BLOCK_EVERYONE,
  type LegacyTeamGraph,
} from '../teams.types';
import {
  isLegacyTeamGraph,
  teamFromLegacyDocument,
  teamFromWorkflow,
} from './team-from-workflow';
import { validateTeam } from './team-validate';

const graph = (overrides: Partial<LegacyTeamGraph>): LegacyTeamGraph => ({
  name: 'g',
  nodes: [],
  edges: [],
  ...overrides,
});

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'agent' as const,
  agent: 'claude' as const,
  approval: 'auto' as const,
  ...extra,
});

describe('teamFromWorkflow', () => {
  it('maps the Dev Team: 6 members, Manager as trigger member, 5 blocks with their audiences, 9 stages with responsible from ownerHint', () => {
    const { team, notes } = teamFromWorkflow(DEV_TEAM_GRAPH);

    expect(team.mode).toBe('lead');
    expect(team.members.map((m) => [m.id, m.name])).toEqual([
      ['manager', 'Manager'],
      ['engineer', 'Senior Engineer'],
      ['middle', 'Middle Engineer'],
      ['researcher', 'Researcher'],
      ['handyman', 'Handyman'],
      ['qa', 'QA'],
    ]);
    expect(team.triggers).toEqual([
      { kind: 'first-message', member: 'manager' },
    ]);
    expect(
      Object.fromEntries(
        team.instructionBlocks.map((block) => [block.id, block.audience]),
      ),
    ).toEqual({
      settings: INSTRUCTION_BLOCK_EVERYONE,
      playbook: ['engineer', 'middle'],
      'review-standard': ['manager', 'engineer', 'qa'],
      'browser-recipe': ['engineer', 'middle', 'qa'],
      memory: INSTRUCTION_BLOCK_EVERYONE,
    });
    expect(
      team.stages?.map((stage) => [stage.id, stage.responsible ?? null]),
    ).toEqual([
      ['triage', ['manager']],
      ['plan', ['researcher']],
      ['build', ['engineer']],
      ['answer', null],
      ['agent-review', ['qa']],
      ['verification', ['middle']],
      ['acceptance', ['manager']],
      ['pr-visuals', ['middle']],
      ['close-out', ['manager']],
    ]);
    expect(notes).toEqual([
      'every member may now call every other; the graph allowed only "manager" → "engineer", "manager" → "researcher", "manager" → "qa", "manager" → "handyman", "engineer" → "researcher", "manager" → "middle", "engineer" → "middle", "middle" → "researcher"',
    ]);
    expect(validateTeam(team).errors).toEqual([]);
  });

  it("makes a node's description its public role and its role its private instructions", () => {
    const { team } = teamFromWorkflow(DEV_TEAM_GRAPH);
    const manager = team.members.find((m) => m.id === 'manager')!;

    expect(manager.role).toBe('PUBLIC manager');
    expect(manager.instructions).toBe('PRIVATE manager');
    expect(manager.model).toBe('opus');
    expect(manager.pool).toEqual([
      { agent: 'cursor-agent', model: 'gemini-4-argon' },
    ]);
  });

  it('turns stage instructions into how to work and doneWhen into the goal', () => {
    const { team } = teamFromWorkflow(DEV_TEAM_GRAPH);

    expect(team.stages?.find((stage) => stage.id === 'build')).toEqual({
      id: 'build',
      title: expect.any(String),
      howToWork: 'HOW build',
      goal: 'GOAL build',
      responsible: ['engineer'],
      next: ['agent-review'],
    });
  });

  it('names each agent → agent data edge it drops, and the call edges that no longer limit calls', () => {
    const { team, notes } = teamFromWorkflow(
      graph({
        nodes: [
          { id: 't', kind: 'trigger', trigger: 'manual' },
          agent('a'),
          agent('b'),
        ],
        edges: [
          { from: 't', to: 'a', kind: 'data' },
          { from: 'a', to: 'b', kind: 'data' },
          { from: 'a', to: 'b', kind: 'call' },
        ],
      }),
    );

    expect(notes).toEqual([
      'dropped the data edge "a" → "b": members hand work on by calling each other',
      'every member may now call every other; the graph allowed only "a" → "b"',
    ]);
    expect(team.triggers).toEqual([{ kind: 'first-message', member: 'a' }]);
  });

  it('hands the first message to the first agent, with a note, when no trigger feeds one', () => {
    const { team, notes } = teamFromWorkflow(
      graph({ nodes: [agent('a'), agent('b')] }),
    );

    expect(team.triggers).toEqual([{ kind: 'first-message', member: 'a' }]);
    expect(notes).toEqual([
      'no trigger fed an agent; "a" handles the first message',
    ]);
  });

  it('keeps only the first fed agent as the trigger member, naming the others', () => {
    const { team, notes } = teamFromWorkflow(
      graph({
        nodes: [
          { id: 't', kind: 'trigger', trigger: 'manual' },
          agent('a'),
          agent('b'),
        ],
        edges: [
          { from: 't', to: 'a', kind: 'data' },
          { from: 't', to: 'b', kind: 'data' },
        ],
      }),
    );

    expect(team.triggers).toEqual([{ kind: 'first-message', member: 'a' }]);
    expect(notes).toEqual([
      'the trigger also fed "b"; only "a" handles the first message',
    ]);
  });

  it('gives an unwired instruction node an empty audience and names an unnamed node by its id', () => {
    const { team } = teamFromWorkflow(
      graph({
        nodes: [
          agent('a'),
          { id: 'loose', kind: 'instruction', instructions: 'text' },
        ],
      }),
    );

    expect(team.instructionBlocks).toEqual([
      { id: 'loose', title: 'loose', text: 'text', audience: [] },
    ]);
    expect(team.members[0]!.name).toBe('a');
  });
});

describe('isLegacyTeamGraph', () => {
  it('tells a node graph from a team', () => {
    expect(isLegacyTeamGraph({ name: 'x', nodes: [], edges: [] })).toBe(true);
    expect(isLegacyTeamGraph({ name: 'x', members: [] })).toBe(false);
    expect(isLegacyTeamGraph(null)).toBe(false);
  });
});

describe('teamFromLegacyDocument', () => {
  it('refuses a graph the legacy schema cannot read, naming the field', () => {
    const read = teamFromLegacyDocument({
      name: 'x',
      nodes: [{ id: 'a', kind: 'agent' }],
    });

    expect(read.success).toBe(false);
    expect(read.success ? '' : read.error).toContain('nodes.0.agent');
  });
});
