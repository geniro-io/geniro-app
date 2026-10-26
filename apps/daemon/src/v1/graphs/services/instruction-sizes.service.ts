import { Injectable } from '@nestjs/common';

import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { joinTurnInstructionParts } from '../../agents/utils/agent-instructions';
import type {
  InstructionBlock,
  InstructionSizePart,
  InstructionSizesWire,
  NodeInstructionSize,
  Workflow,
  WorkflowAgentNode,
} from '../graphs.types';
import { onDemandNodeIds } from '../utils/graph-order';
import {
  calleesByNode,
  instructionBlocksByNode,
  nodeInstructionFields,
} from '../utils/node-instructions';

/**
 * The common rough rule for English prose. The readout says "approximate"
 * because each model's tokenizer differs, and none of them is run here.
 */
const CHARS_PER_TOKEN = 4;

export interface InstructionSizesInput {
  workflow: Pick<Workflow, 'nodes' | 'edges'>;
  customInstructions?: string;
  replyLanguage?: string;
}

/**
 * Measures the always-on instruction block each agent node's turns carry — the
 * text paid for on every turn before the prompt itself. The block is composed
 * by the node's own adapter (`AgentAdapter.turnInstructionParts`) from the same
 * graph helpers the executor uses, so the total is the block a run sends.
 *
 * What a saved workflow cannot know is left out: a board card's instructions
 * and the builder chat's brief belong to one run, and ACP's `<host-context>`
 * wrapper is added after composition.
 */
@Injectable()
export class InstructionSizesService {
  constructor(private readonly adapters: AgentAdapterRegistry) {}

  measure(input: InstructionSizesInput): InstructionSizesWire {
    const { workflow } = input;
    const blocksOf = instructionBlocksByNode(workflow);
    const calleesOf = calleesByNode(workflow);
    const onDemand = onDemandNodeIds(workflow.nodes, workflow.edges);
    const nodes: NodeInstructionSize[] = [];
    for (const node of workflow.nodes) {
      if (node.kind !== 'agent') {
        continue;
      }
      nodes.push(
        this.measureNode(node, {
          blocks: blocksOf.get(node.id) ?? [],
          callees: calleesOf.get(node.id),
          answeringACall: onDemand.has(node.id),
          customInstructions: input.customInstructions,
          replyLanguage: input.replyLanguage,
        }),
      );
    }
    return { nodes };
  }

  private measureNode(
    node: WorkflowAgentNode,
    context: {
      blocks: readonly InstructionBlock[];
      callees: readonly WorkflowAgentNode[] | undefined;
      answeringACall: boolean;
      customInstructions: string | undefined;
      replyLanguage: string | undefined;
    },
  ): NodeInstructionSize {
    const adapter = this.adapters.for(node.agent);
    const parts = adapter.turnInstructionParts(
      {
        customInstructions: context.customInstructions,
        replyLanguage: context.replyLanguage,
        ...nodeInstructionFields(node, {
          blocks: context.blocks,
          callees: context.callees,
          answeringACall: context.answeringACall,
          config: adapter.getConfig(),
        }),
      },
      // As if the CLI's delivery of the call tools succeeded — the turn the
      // executor hands an endpoint to (`mcpEndpointFor`).
      true,
    );
    const totalChars = joinTurnInstructionParts(parts).length;
    const measured = parts.flatMap((part): InstructionSizePart[] =>
      // One row per wired block: the joined part is those blocks and the
      // breaks between them, so the breaks move to `separatorChars`.
      part.source === 'instructionBlocks'
        ? context.blocks.map((block) => ({
            source: part.source,
            instructionNodeId: block.nodeId,
            ...sizeOf(block.text.length),
          }))
        : [{ source: part.source, ...sizeOf(part.text.length) }],
    );
    return {
      nodeId: node.id,
      agent: node.agent,
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
  return { chars, approxTokens: Math.ceil(chars / CHARS_PER_TOKEN) };
}
