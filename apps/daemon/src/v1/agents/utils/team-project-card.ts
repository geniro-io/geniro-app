import {
  HOST_PLUGIN_TOOL,
  HOST_PROJECT_INSTRUCTIONS_TOOL,
  type HostPluginProposal,
  type HostProjectInstructions,
} from '../chat.types';
import { readHostPluginProposal } from './host-plugin';
import { readHostProjectInstructions } from './host-project-instructions';

/**
 * A team run's standing lead write card, as `Run.pendingTeamProjectCard`
 * holds it: the lead's `save_project_instructions` or its `save_plugin`.
 * One per run, whichever it is. A row without `kind` is a project card,
 * written before plugin cards existed.
 */
export type PendingTeamProjectCard =
  | { kind: 'project'; requestId: string; change: HostProjectInstructions }
  | { kind: 'plugin'; requestId: string; proposal: HostPluginProposal };

export function serializeTeamProjectCard(card: PendingTeamProjectCard): string {
  return JSON.stringify(card);
}

function parsed(value: string | null): Record<string, unknown> | null {
  if (value === null || value.length === 0) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(value);
    return raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The card's id, even when its change no longer reads — so it can still be closed. */
export function teamProjectCardId(value: string | null): string | null {
  const requestId = parsed(value)?.requestId;
  return typeof requestId === 'string' && requestId.length > 0
    ? requestId
    : null;
}

/** The tool whose card the column holds, read even from a row no reader accepts. */
export function teamProjectCardTool(value: string | null): string {
  return parsed(value)?.kind === 'plugin'
    ? HOST_PLUGIN_TOOL
    : HOST_PROJECT_INSTRUCTIONS_TOOL;
}

export function readTeamProjectCard(
  value: string | null,
): PendingTeamProjectCard | null {
  const requestId = teamProjectCardId(value);
  const record = parsed(value);
  if (requestId === null || record === null) {
    return null;
  }
  if (record.kind === 'plugin') {
    const proposal = readHostPluginProposal(record.proposal);
    return proposal === null ? null : { kind: 'plugin', requestId, proposal };
  }
  if (record.kind !== undefined && record.kind !== 'project') {
    return null;
  }
  const change = readHostProjectInstructions(record.change);
  return change === null ? null : { kind: 'project', requestId, change };
}
