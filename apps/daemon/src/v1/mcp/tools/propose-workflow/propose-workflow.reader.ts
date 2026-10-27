import { z } from 'zod';

import { hasHiddenText } from '../../../agents/utils/hidden-text';
import {
  type ProposalOutcome,
  WORKFLOW_REASON_MAX,
  WORKFLOW_SUMMARY_MAX,
  type WorkflowChangeProposalRequest,
  type WorkflowProposalRequest,
} from '../../../graphs/graphs.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';
import { editsField } from '../workflow-edit-args';

// One line, capped: the card prints this ahead of the slug and the workflow,
// so an unbounded one could push them out of sight.
const summaryField = z
  .string()
  .max(WORKFLOW_SUMMARY_MAX)
  .refine(
    (summary) => !hasHiddenText(summary, false),
    'summary must be one line of visible text',
  );

// Capped for the same reason; line breaks are kept, the card draws them.
const reasonField = z
  .string()
  .max(WORKFLOW_REASON_MAX)
  .refine(
    (reason) => !hasHiddenText(reason, true),
    'reason must be visible text',
  );

/**
 * Strict on the names, so a misspelt `replace` cannot quietly turn a
 * replacement into a second workflow. The workflow itself is read whole and
 * checked by the service against the library's own schema.
 */
const ProposeWorkflowArgsSchema = z
  .object({
    workflow: z.record(z.string(), z.unknown()),
    replaces: z.string().min(1).optional(),
    summary: summaryField.optional(),
    reason: reasonField.optional(),
  })
  .strict();

/**
 * A workflow builder chat's proposal: edits to its own workflow, never the
 * whole of it, and no target — the slug is the chat's. `workflow` and
 * `replaces` are refused as unknown. What it changes and why are required:
 * they are the card's account of a change the user did not draw themselves.
 */
export const ProposeWorkflowChangeArgsSchema = z
  .object({
    edits: editsField('the workflow file as it stands'),
    summary: summaryField,
    reason: reasonField,
  })
  .strict();

/** The call's arguments, or what is wrong with them. Never throws. */
export function readProposeWorkflowArgs(
  args: Record<string, unknown>,
): ToolArgs<WorkflowProposalRequest> {
  return readToolArgs(ProposeWorkflowArgsSchema, args);
}

/** A builder chat's call arguments, or what is wrong with them. Never throws. */
export function readProposeWorkflowChangeArgs(
  args: Record<string, unknown>,
): ToolArgs<Omit<WorkflowChangeProposalRequest, 'slug'>> {
  return readToolArgs(ProposeWorkflowChangeArgsSchema, args);
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
