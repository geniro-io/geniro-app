/**
 * Compact "last activity" label for the chat list: "just now", "5m", "3h",
 * "6d", then a short date ("Jul 12" / "Jul 12, 2025" across years). Pure —
 * `now` is injectable so specs pin exact thresholds.
 */
export function formatRelativeTime(
  iso: string,
  now: number = Date.now(),
): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '';
  }
  const elapsedMs = now - then;
  if (elapsedMs < 60_000) {
    return 'just now';
  }
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * A full, unambiguous moment for a hover — "Sep 24, 2026, 14:07" — for where a
 * relative label ("3h", "just now") has to be pinned to the time it stands
 * for. Empty when unparseable, like its siblings here.
 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * The three dates a sidebar row stands for, one per line — the hover on its
 * relative time. REPORTED against the archive: every row read "just now" and
 * nothing anywhere said when a thread was made, last worked in, or shelved.
 * A line is left out for a date the row does not have.
 */
export function runDatesTitle({
  lastActivityAt,
  createdAt,
  archivedAt,
}: {
  lastActivityAt: string;
  createdAt: string;
  archivedAt: string | null;
}): string {
  const dates: [string, string | null][] = [
    ['Last activity', lastActivityAt],
    ['Created', createdAt],
    ['Archived', archivedAt],
  ];
  const lines: string[] = [];
  for (const [label, iso] of dates) {
    const text = iso === null ? '' : formatDateTime(iso);
    if (text !== '') {
      lines.push(`${label}: ${text}`);
    }
  }
  return lines.join('\n');
}

/** A message's clock-time metadata line, e.g. "14:07". Empty when unparseable. */
export function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
