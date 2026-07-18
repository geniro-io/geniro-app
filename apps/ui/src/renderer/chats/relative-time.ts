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
