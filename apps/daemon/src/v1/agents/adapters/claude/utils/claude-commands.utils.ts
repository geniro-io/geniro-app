import type { AgentReportedCommand } from '../../adapter.types';
import {
  CLAUDE_COMMANDS_CHANGED_KEY,
  CLAUDE_COMMANDS_CHANGED_SUBTYPE,
  CLAUDE_RELOAD_COMMANDS_SUBTYPE,
} from '../claude.const';

/**
 * The reload/announce dialogue that gets this CLI's command list WITH the
 * sentence beside each entry.
 *
 * Pure, like every other wire reader here: the state (which turn asked) lives
 * on the per-turn driver, and everything below is the shape it reads — so a
 * spec drives both halves with no child process. The probe evidence, the three
 * live measurements behind it and the expiry warning are recorded at
 * {@link CLAUDE_RELOAD_COMMANDS_SUBTYPE} in `claude.const.ts`.
 */

/** The reload request, newline-terminated for the stdin dialogue. */
export function reloadCommandsRequestLine(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: CLAUDE_RELOAD_COMMANDS_SUBTYPE },
  })}\n`;
}

/**
 * The commands one parsed stdout line announces, or null when it is not that
 * announcement.
 *
 * Null rather than `[]` for a line that is about something else, because the
 * two mean opposite things to the caller: an announcement of no commands is an
 * answer, and every other line is not this line at all.
 */
export function readCommandsChanged(
  obj: unknown,
): AgentReportedCommand[] | null {
  if (typeof obj !== 'object' || obj === null) {
    return null;
  }
  const line = obj as Record<string, unknown>;
  if (
    line.type !== 'system' ||
    line.subtype !== CLAUDE_COMMANDS_CHANGED_SUBTYPE
  ) {
    return null;
  }
  const rows = line[CLAUDE_COMMANDS_CHANGED_KEY];
  if (!Array.isArray(rows)) {
    return null;
  }
  const commands: AgentReportedCommand[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const entry = row as { name?: unknown; description?: unknown };
    if (typeof entry.name !== 'string' || entry.name === '') {
      continue;
    }
    commands.push({
      name: entry.name,
      // An entry the CLI describes with an empty string is one it has no
      // sentence for, and `null` is how every other source spells that — a
      // blank would render as a description that is merely invisible, and
      // would beat a real one from the disk scan in the merge.
      description:
        typeof entry.description === 'string' && entry.description !== ''
          ? entry.description
          : null,
    });
  }
  return commands;
}
