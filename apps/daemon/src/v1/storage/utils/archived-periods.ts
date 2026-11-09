import type { ArchivedWindow } from '../../agents/chat.types';

const DAY_MS = 24 * 60 * 60 * 1000;

export const ARCHIVED_PERIOD_DAYS = [7, 30, 60, 90] as const;

/**
 * The chats a period names: those archived within its last `days` days, or
 * every one for null. The only place the page's delete decides its direction;
 * the renderer posts this window back and words it.
 */
export function archivedPeriodWindow(
  days: number | null,
  now: Date,
): ArchivedWindow {
  return {
    from: days === null ? null : new Date(now.getTime() - days * DAY_MS),
    to: now,
  };
}
