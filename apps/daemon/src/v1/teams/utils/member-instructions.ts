import type {
  AdapterConfig,
  TurnInstructionInput,
} from '../../agents/adapters/adapter.types';
import { TURN_INSTRUCTION_SEPARATOR } from '../../agents/utils/agent-instructions';
import {
  type ComposedInstructionBlock,
  INSTRUCTION_BLOCK_EVERYONE,
  type Team,
  type TeamMember,
} from '../teams.types';
import {
  ANSWERING_A_CALL,
  ANSWERING_WITH_CALLS_OUT,
  CALLEE_DESCRIPTION_MAX,
  calleeSummary,
} from './callee-text';
import { COLD_RESUME_RULE } from './prompt-cache-standing';

/**
 * The team's share of a member's turn instructions — the blocks addressed to
 * it and its "May call" block — worked out from the team alone. The executor
 * composes every turn from these, and the inspector's size readout measures
 * the same text, so neither can drift from the other.
 */

/**
 * The instruction blocks each member is in the audience of, in the team's
 * block order, so two blocks on one member read the same way every run. Every
 * block is sent whole, whatever its length; a blank one is dropped, and an
 * audience id that names no member reaches nobody.
 */
export function instructionBlocksByMember(
  team: Pick<Team, 'members' | 'instructionBlocks'>,
): Map<string, ComposedInstructionBlock[]> {
  const blocksOf = new Map<string, ComposedInstructionBlock[]>();
  for (const block of team.instructionBlocks) {
    const text = block.text.trim();
    if (!text) {
      continue;
    }
    const audience =
      block.audience === INSTRUCTION_BLOCK_EVERYONE
        ? team.members.map((member) => member.id)
        : block.audience;
    for (const id of new Set(audience)) {
      const list = blocksOf.get(id);
      const entry = { blockId: block.id, text };
      if (list) {
        list.push(entry);
      } else {
        blocksOf.set(id, [entry]);
      }
    }
  }
  return blocksOf;
}

/**
 * Several blocks addressed to one member as the one `instructionBlocks` part — joined by
 * the separator the composed block puts between parts, so each reads as its
 * own paragraph. Null when none is addressed to it.
 */
export function joinInstructionBlocks(
  blocks: readonly ComposedInstructionBlock[] | undefined,
): string | null {
  return blocks?.length
    ? blocks.map((block) => block.text).join(TURN_INSTRUCTION_SEPARATOR)
    : null;
}

/**
 * A caller's "May call" block, naming every other member and its public role,
 * so the agent can route work from the team alone — its own instructions
 * never have to name the team. Members' private instructions stay private
 * (see `calleeSummary`).
 *
 * `questionToolName` is the caller's CLI's question tool (`AdapterConfig`):
 * a caller that has one can relay a callee's question to the user; one without
 * it can only answer or let the call time out.
 */
export function callSurfaceText(
  callees: readonly TeamMember[],
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

/** Whether a member holds the call tools: it has someone to call, on an admitted CLI. */
export function holdsCallTools(
  callees: readonly TeamMember[] | undefined,
  config: Pick<AdapterConfig, 'mcp'>,
): callees is readonly TeamMember[] {
  return (
    callees !== undefined && callees.length > 0 && callToolsAdmitted(config)
  );
}

/**
 * The team's fields of one member's turn instructions — its blocks, its own
 * instructions and character, the answering-a-call note and its "May call"
 * block. The executor composes every member turn from these, and the size
 * readout measures the same.
 */
export function memberInstructionFields(
  member: TeamMember,
  context: {
    blocks: readonly ComposedInstructionBlock[] | undefined;
    callees: readonly TeamMember[] | undefined;
    /** Whether this turn answers a call. */
    answeringACall: boolean;
    /** The config of the CLI the member's turn runs on. */
    config: Pick<AdapterConfig, 'mcp' | 'questionToolName'>;
    stageMap: string | null;
  },
): Pick<
  TurnInstructionInput,
  | 'instructionBlocks'
  | 'stageMapPrompt'
  | 'systemPrompt'
  | 'characterPrompt'
  | 'answeringACallPrompt'
  | 'callSurfacePrompt'
> {
  const { callees, config, answeringACall } = context;
  return {
    instructionBlocks: joinInstructionBlocks(context.blocks),
    stageMapPrompt: callToolsAdmitted(config) ? context.stageMap : null,
    systemPrompt: member.instructions ?? null,
    characterPrompt: member.character ?? null,
    // Every callee, a leaf included: one with no callees gets no "May call"
    // block to carry it.
    answeringACallPrompt: answeringACall ? ANSWERING_A_CALL : null,
    callSurfacePrompt: holdsCallTools(callees, config)
      ? callSurfaceText(callees, config.questionToolName, answeringACall)
      : null,
  };
}
