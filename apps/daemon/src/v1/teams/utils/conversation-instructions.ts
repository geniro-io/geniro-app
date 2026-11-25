import { createHash } from 'node:crypto';

import { z } from 'zod';

const RecordedSchema = z.record(z.string(), z.string());

/** The text a conversation's team instructions are compared by. */
export function teamInstructionsHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * `Run.conversationInstructions` read: per session key, the hash of the team
 * instructions its conversation last ran under. A column that cannot be read
 * records nothing, so no note is owed from it.
 */
export function readConversationInstructions(
  column: string | null,
): Record<string, string> {
  if (column === null) {
    return {};
  }
  try {
    const parsed = RecordedSchema.safeParse(JSON.parse(column));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * The note that opens a resumed conversation's turn when its team instructions
 * changed since it last ran, on a CLI whose resumed session keeps the
 * instructions it started with (`AdapterConfig.resumeKeepsInstructionsReason`).
 */
export function changedInstructionsNote(teamInstructions: string): string {
  const text = teamInstructions.trim();
  return text === ''
    ? 'Your team instructions were removed: disregard the team instructions you were given earlier in this conversation.'
    : `Your team instructions have changed. The block below replaces the team instructions you were given earlier in this conversation, if any; follow it from now on:\n<team-instructions>\n${text}\n</team-instructions>`;
}
