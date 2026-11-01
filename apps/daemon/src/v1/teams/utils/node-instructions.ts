import type {
  AdapterConfig,
  TurnInstructionInput,
} from '../../agents/adapters/adapter.types';
import { TURN_INSTRUCTION_SEPARATOR } from '../../agents/utils/agent-instructions';
import type { InstructionBlock, Team, TeamAgentNode } from '../teams.types';
import {
  ANSWERING_A_CALL,
  ANSWERING_WITH_CALLS_OUT,
  CALLEE_DESCRIPTION_MAX,
  calleeSummary,
} from './callee-text';
import { COLD_RESUME_RULE } from './prompt-cache-standing';

/**
 * The team's share of an agent node's turn instructions — its wired
 * instruction blocks and its "May call" block — worked out from the graph
 * alone. The executor composes every turn from these, and the inspector's size
 * readout measures the same text, so neither can drift from the other.
 */

/**
 * The instruction blocks wired to each agent node, in NODE-LIST order — the
 * order the YAML file and the builder's own list already put them in, so two
 * blocks on one agent read the same way every run. Every block is sent whole,
 * whatever its length; a blank one is dropped.
 */
export function instructionBlocksByNode(
  team: Pick<Team, 'nodes' | 'edges'>,
): Map<string, InstructionBlock[]> {
  // Indexed once, so a large draft costs nodes + edges rather than their
  // product — the inspector measures on every edit.
  const targetsOf = new Map<string, string[]>();
  for (const edge of team.edges) {
    if (edge.kind === 'instruction') {
      pushTo(targetsOf, edge.from, edge.to);
    }
  }
  const blocksOf = new Map<string, InstructionBlock[]>();
  for (const source of team.nodes) {
    if (source.kind !== 'instruction') {
      continue;
    }
    const text = source.instructions.trim();
    if (!text) {
      continue;
    }
    for (const target of targetsOf.get(source.id) ?? []) {
      pushTo(blocksOf, target, { nodeId: source.id, text });
    }
  }
  return blocksOf;
}

/**
 * Several blocks on one node as the one `instructionBlocks` part — joined by
 * the separator the composed block puts between parts, so each reads as its
 * own paragraph. Null when the node has none.
 */
export function joinInstructionBlocks(
  blocks: readonly InstructionBlock[] | undefined,
): string | null {
  return blocks?.length
    ? blocks.map((block) => block.text).join(TURN_INSTRUCTION_SEPARATOR)
    : null;
}

/** Caller → callee agent nodes, from the call edges, in edge order. */
export function calleesByNode(
  team: Pick<Team, 'nodes' | 'edges'>,
): Map<string, TeamAgentNode[]> {
  const nodesById = new Map(team.nodes.map((n) => [n.id, n]));
  const calleesOf = new Map<string, TeamAgentNode[]>();
  for (const edge of team.edges) {
    if (edge.kind !== 'call') {
      continue;
    }
    const callee = nodesById.get(edge.to);
    if (callee?.kind !== 'agent') {
      continue;
    }
    pushTo(calleesOf, edge.from, callee);
  }
  return calleesOf;
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * A caller's "May call" block, naming each callee and what that callee says it
 * does, so the agent can route work from the graph alone — its own role never
 * has to name the team. Callee ROLES stay private (see `calleeSummary`).
 *
 * `questionToolName` is the caller's CLI's question tool (`AdapterConfig`):
 * a caller that has one can relay a callee's question to the user; one without
 * it can only answer or let the call time out.
 */
export function callSurfaceText(
  callees: readonly TeamAgentNode[],
  questionToolName: string | null,
  /** Whether this turn answers a call — see `ANSWERING_WITH_CALLS_OUT`. */
  answeringACall: boolean,
): string {
  const lines = callees.map(
    (callee) => `- ${calleeSummary(callee, CALLEE_DESCRIPTION_MAX)}`,
  );
  const questionLine =
    questionToolName !== null
      ? `A callee may pause with a {"status":"question"} envelope: answer via answer_agent when your role/context makes you confident; otherwise ask the user with your ${questionToolName} tool and relay their answer. Then collect the final result with await_agent.`
      : 'A callee may pause with a {"status":"question"} envelope: answer via answer_agent from your role/context — you cannot escalate to the user; an unanswered question times the call out.';
  return `May call (via the call_agent tool; await_agent collects async results):\n${lines.join('\n')}\n${questionLine}\nPrefer async calls: launch them, keep working or end your turn, and you are started again when a call finishes or asks you something — do not sit waiting on a callee while you have other work.\nWhen you learn something that changes a RUNNING call's work — the user corrects what they asked for — send it into that call at once with message_agent(call_id, message) instead of waiting for the call to finish.\nWhen a call has become POINTLESS — its premise refuted, its task withdrawn, or its own output showing it is building the wrong thing — stop it with cancel_agent(call_id, reason) and say so to the user. A slow callee is not that case: check in with await_agent(timeout_ms) instead.\nBefore continuing an earlier conversation with call_agent(thread), above all after a pause, check it with list_agent_threads. ${COLD_RESUME_RULE}${answeringACall ? `\n${ANSWERING_WITH_CALLS_OUT}` : ''}`;
}

/**
 * Whether a CLI may hold the call tools in a run: only one whose call tools
 * need no machine-trust probe. The one rule behind every admission surface —
 * the endpoint grant, the token minting, the "May call" block (and so the
 * inspector's size readout) and the self-check.
 */
export function callToolsAdmitted(config: Pick<AdapterConfig, 'mcp'>): boolean {
  return !config.mcp.callToolsRequireTrustProbe;
}

/** Whether a node holds the call tools: it has callees, on an admitted CLI. */
export function holdsCallTools(
  callees: readonly TeamAgentNode[] | undefined,
  config: Pick<AdapterConfig, 'mcp'>,
): callees is readonly TeamAgentNode[] {
  return callees !== undefined && callToolsAdmitted(config);
}

/**
 * The graph's fields of one agent node's turn instructions — its blocks, its
 * role, the answering-a-call note and its "May call" block. The executor
 * composes every node turn from these, and the size readout measures the same.
 */
export function nodeInstructionFields(
  node: TeamAgentNode,
  context: {
    blocks: readonly InstructionBlock[] | undefined;
    callees: readonly TeamAgentNode[] | undefined;
    /** Whether this turn answers a call. */
    answeringACall: boolean;
    /** The config of the CLI the node's turn runs on. */
    config: Pick<AdapterConfig, 'mcp' | 'questionToolName'>;
    stageMap: string | null;
  },
): Pick<
  TurnInstructionInput,
  | 'instructionBlocks'
  | 'stageMapPrompt'
  | 'systemPrompt'
  | 'answeringACallPrompt'
  | 'callSurfacePrompt'
> {
  const { callees, config, answeringACall } = context;
  return {
    instructionBlocks: joinInstructionBlocks(context.blocks),
    stageMapPrompt: callToolsAdmitted(config) ? context.stageMap : null,
    systemPrompt: node.role ?? null,
    // Every callee, a leaf included: one with no callees gets no "May call"
    // block to carry it.
    answeringACallPrompt: answeringACall ? ANSWERING_A_CALL : null,
    callSurfacePrompt: holdsCallTools(callees, config)
      ? callSurfaceText(callees, config.questionToolName, answeringACall)
      : null,
  };
}
