import { z } from 'zod';

import { hasHiddenText } from '../../../agents/utils/hidden-text';
import {
  type ProposalOutcome,
  WORKFLOW_SUMMARY_MAX,
  type WorkflowProposalRequest,
} from '../../../graphs/graphs.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/**
 * Strict on the names, so a misspelt `replace` cannot quietly turn a
 * replacement into a second workflow. The workflow itself is read whole and
 * checked by the service against the library's own schema.
 */
const ProposeWorkflowArgsSchema = z
  .object({
    workflow: z.record(z.string(), z.unknown()),
    replaces: z.string().min(1).optional(),
    // One line, capped: the card prints this ahead of the slug and the
    // workflow, so an unbounded one could push them out of sight.
    summary: z
      .string()
      .max(WORKFLOW_SUMMARY_MAX)
      .refine(
        (summary) => !hasHiddenText(summary, false),
        'summary must be one line of visible text',
      )
      .optional(),
  })
  .strict();

/** The call's arguments, or what is wrong with them. Never throws. */
export function readProposeWorkflowArgs(
  args: Record<string, unknown>,
): ToolArgs<WorkflowProposalRequest> {
  return readToolArgs(ProposeWorkflowArgsSchema, args);
}

/** What the agent is told once the call is answered. */
export function proposeWorkflowResultText(outcome: ProposalOutcome): string {
  if (outcome.status === 'refused') {
    return `Not proposed — ${outcome.code}: ${outcome.message}. No card was shown.`;
  }
  const { proposal } = outcome;
  const what =
    proposal.mode === 'create'
      ? `a new workflow, to be saved as '${proposal.slug}'`
      : `a replacement of '${proposal.slug}' (${proposal.replacesName})`;
  return `Shown to the user on a card: ${what}. Nothing is saved until they approve. End your turn now — their verdict arrives as your next message.`;
}
