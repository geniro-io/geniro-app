import { Injectable } from '@nestjs/common';

import type { TurnInstructionInput } from '../../agents/adapters/adapter.types';
import type { AgentAdapter } from '../../agents/adapters/agent-adapter';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import {
  approxInstructionTokens,
  joinTurnInstructionParts,
} from '../../agents/utils/agent-instructions';
import type {
  AgentInstructionSize,
  ComposedInstructionBlock,
  InstructionBlockSize,
  InstructionSizePart,
  InstructionSizesWire,
  MemberInstructionSize,
  ProjectInstructionSizesWire,
  Team,
  TeamMember,
  TeamOverlay,
} from '../teams.types';
import {
  instructionBlocksByMember,
  memberInstructionFields,
} from '../utils/member-instructions';
import { stageMapOf } from '../utils/stage-text';
import { applyTeamOverlay } from '../utils/team-overlay';
import { calleesOf, onDemandMemberIds } from '../utils/team-roster';

/** What every run in one project carries, whatever its CLI or team. */
export interface ProjectInstructionSizesInput {
  customInstructions?: string;
  replyLanguage?: string;
  projectInstructions?: string;
  memoryIndex?: string;
}

export interface InstructionSizesInput {
  team: Pick<
    Team,
    'members' | 'triggers' | 'instructionBlocks' | 'stages' | 'mode'
  >;
  customInstructions?: string;
  replyLanguage?: string;
  /** A board card's instructions — known only when measuring for one run. */
  taskInstructions?: string;
  /** The run's project's instructions — known only when measuring for one run. */
  projectInstructions?: string;
  /** The shared memory's index — known only when measuring for one run. */
  memoryIndex?: string;
}

/**
 * Measures the always-on instruction block each member's turns carry — the
 * text paid for on every turn before the prompt itself. The block is composed
 * by the member's own adapter (`AgentAdapter.turnInstructionParts`) from the
 * same team helpers the executor uses, so the total is the block a run sends.
 *
 * What a saved team cannot know is left out: a board card's instructions,
 * the project's instructions and the memory index belong to one run (measured only when the caller names
 * that run's), the
 * builder chat's brief to one chat, and ACP's `<host-context>` wrapper is
 * added after composition.
 */
@Injectable()
export class InstructionSizesService {
  constructor(private readonly adapters: AgentAdapterRegistry) {}

  /** {@link measure} for the team editor: with a project's overlay, the team as that project runs it. */
  measureFor(
    input: InstructionSizesInput & {
      team: Team;
      projectId?: string;
      overlay?: TeamOverlay;
    },
  ): InstructionSizesWire {
    const { projectId, overlay, ...rest } = input;
    if (projectId === undefined || overlay === undefined) {
      return this.measure(rest);
    }
    return this.measure({
      ...rest,
      team: applyTeamOverlay(input.team, overlay, projectId).team,
    });
  }

  measure(input: InstructionSizesInput): InstructionSizesWire {
    const { team } = input;
    const blocksOf = instructionBlocksByMember(team);
    const callees = calleesOf(team.members);
    const onDemand = onDemandMemberIds(team);
    const stageMap = stageMapOf(team);
    const members: MemberInstructionSize[] = [];
    for (const member of team.members) {
      members.push(
        this.measureMember(member, {
          blocks: blocksOf.get(member.id) ?? [],
          callees: callees.get(member.id),
          answeringACall: onDemand.has(member.id),
          customInstructions: input.customInstructions,
          replyLanguage: input.replyLanguage,
          taskInstructions: input.taskInstructions,
          projectInstructions: input.projectInstructions,
          memoryIndex: input.memoryIndex,
          stageMap,
        }),
      );
    }
    return { members, blocks: blockSizesOf(team, blocksOf) };
  }

  /**
   * The block each CLI's turn in a project carries before any team or task
   * adds to it: the preamble, the user's own settings, the project's
   * instructions and the memory index a run there would snapshot.
   */
  measureProject(
    input: ProjectInstructionSizesInput,
  ): Omit<ProjectInstructionSizesWire, 'blocks'> {
    return {
      agents: [...this.adapters.all().entries()].map(
        ([agent, adapter]): AgentInstructionSize => ({
          agent,
          ...measuredParts(adapter, { ...input }),
        }),
      ),
    };
  }

  private measureMember(
    member: TeamMember,
    context: {
      blocks: readonly ComposedInstructionBlock[];
      callees: readonly TeamMember[] | undefined;
      answeringACall: boolean;
      customInstructions: string | undefined;
      replyLanguage: string | undefined;
      taskInstructions: string | undefined;
      projectInstructions: string | undefined;
      memoryIndex: string | undefined;
      stageMap: string | null;
    },
  ): MemberInstructionSize {
    const adapter = this.adapters.for(member.agent);
    const parts = adapter.turnInstructionParts(
      {
        customInstructions: context.customInstructions,
        replyLanguage: context.replyLanguage,
        taskInstructions: context.taskInstructions,
        projectInstructions: context.projectInstructions,
        memoryIndex: context.memoryIndex,
        ...memberInstructionFields(member, {
          blocks: context.blocks,
          callees: context.callees,
          answeringACall: context.answeringACall,
          config: adapter.getConfig(),
          stageMap: context.stageMap,
        }),
      },
      // As if the CLI's delivery of the call tools succeeded — the turn the
      // executor hands an endpoint to (`mcpEndpointFor`).
      true,
    );
    const totalChars = joinTurnInstructionParts(parts).length;
    const measured = parts.flatMap((part): InstructionSizePart[] =>
      // One row per block: the joined part is those blocks and the breaks
      // between them, so the breaks move to `separatorChars`.
      part.source === 'instructionBlocks'
        ? context.blocks.map((block) => ({
            source: part.source,
            blockId: block.blockId,
            ...sizeOf(block.text.length),
          }))
        : [{ source: part.source, ...sizeOf(part.text.length) }],
    );
    return {
      memberId: member.id,
      agent: member.agent,
      turn: context.answeringACall ? 'call' : 'own',
      totalChars,
      approxTokens: sizeOf(totalChars).approxTokens,
      separatorChars:
        totalChars - measured.reduce((sum, part) => sum + part.chars, 0),
      parts: measured,
    };
  }
}

export function sizeOf(chars: number): {
  chars: number;
  approxTokens: number;
} {
  return { chars, approxTokens: approxInstructionTokens(chars) };
}

function measuredParts(
  adapter: AgentAdapter,
  input: TurnInstructionInput,
): Omit<AgentInstructionSize, 'agent'> {
  const parts = adapter.turnInstructionParts(input, true);
  const totalChars = joinTurnInstructionParts(parts).length;
  const measured = parts.map((part): InstructionSizePart => ({
    source: part.source,
    ...sizeOf(part.text.length),
  }));
  return {
    totalChars,
    approxTokens: sizeOf(totalChars).approxTokens,
    separatorChars:
      totalChars - measured.reduce((sum, part) => sum + part.chars, 0),
    parts: measured,
  };
}

/** Every block in the team's order, with how many members' turns carry it. */
function blockSizesOf(
  team: Pick<Team, 'members' | 'instructionBlocks'>,
  blocksOf: ReadonlyMap<string, readonly ComposedInstructionBlock[]>,
): InstructionBlockSize[] {
  const reaches = new Map<string, number>();
  for (const member of team.members) {
    for (const block of blocksOf.get(member.id) ?? []) {
      reaches.set(block.blockId, (reaches.get(block.blockId) ?? 0) + 1);
    }
  }
  return team.instructionBlocks.map((block) => ({
    blockId: block.id,
    ...sizeOf(block.text.trim().length),
    reaches: reaches.get(block.id) ?? 0,
  }));
}
