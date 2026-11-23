import { z } from 'zod';

import {
  MILESTONE_TEXT_MAX_CHARS,
  type MilestoneInput,
  MilestoneKindSchema,
  type MilestoneWriteOutcome,
} from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import { hasHiddenText } from '../../../agents/utils/hidden-text';
import { readToolArgs } from '../tool-args';

const MilestoneArgsSchema = z
  .object({
    text: z
      .string()
      .refine(
        (text) => !hasHiddenText(text, true),
        'text holds a control or format character',
      ),
    kind: MilestoneKindSchema.optional(),
  })
  .strict();

/**
 * The call's arguments, or what is wrong with them. Never throws. A long step
 * is cut rather than refused: the agent has already done the work it names.
 */
export function readMilestone(
  args: Record<string, unknown>,
): MilestoneInput | { error: string } {
  const read = readToolArgs(MilestoneArgsSchema, args);
  if (!read.ok) {
    return { error: read.error };
  }
  const line = read.query.text.replace(/\s+/gu, ' ').trim();
  if (line === '') {
    return { error: 'text is empty: say the step in a few words' };
  }
  // Cut on code points, so a step ending in an emoji keeps it whole.
  const points = [...line];
  const text =
    points.length <= MILESTONE_TEXT_MAX_CHARS
      ? line
      : `${points
          .slice(0, MILESTONE_TEXT_MAX_CHARS - 1)
          .join('')
          .trimEnd()}…`;
  return { text, kind: read.query.kind ?? 'progress' };
}

/** The receipt for a step that was not refused. */
export function milestoneResultText(
  outcome:
    Exclude<MilestoneWriteOutcome, { status: 'refused' }> | HostSinkUnavailable,
): string {
  if (outcome.status === 'unavailable') {
    return `Not recorded: ${outcome.reason}.`;
  }
  return outcome.status === 'unchanged'
    ? `Unchanged: step ${outcome.seq} already says this, so nothing was written.`
    : `Step recorded (${outcome.seq}).`;
}
