import type { HostProjectInstructions } from '../chat.types';
import { readHostProjectInstructions } from './host-project-instructions';

/** A team run's standing project card, as `Run.pendingTeamProjectCard` holds it. */
export interface PendingTeamProjectCard {
  requestId: string;
  change: HostProjectInstructions;
}

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

export function readTeamProjectCard(
  value: string | null,
): PendingTeamProjectCard | null {
  const requestId = teamProjectCardId(value);
  const change = readHostProjectInstructions(parsed(value)?.change);
  return requestId === null || change === null ? null : { requestId, change };
}
