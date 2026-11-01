import { Injectable } from '@nestjs/common';

import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import {
  approxInstructionTokens,
  joinTurnInstructionParts,
} from '../../agents/utils/agent-instructions';
import type {
  ComposedInstructionBlock,
  InstructionSizePart,
  InstructionSizesWire,
  MemberInstructionSize,
  Team,
  TeamMember,
} from '../teams.types';
import {
  instructionBlocksByMember,
  memberInstructionFields,
} from '../utils/member-instructions';
import { stageMapOf } from '../utils/stage-text';
import { calleesOf, onDemandMemberIds } from '../utils/team-roster';

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
    return { members };
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

function sizeOf(chars: number): { chars: number; approxTokens: number } {
  return { chars, approxTokens: approxInstructionTokens(chars) };
}
