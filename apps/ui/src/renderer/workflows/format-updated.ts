/**
 * Format a workflow's ISO `updatedAt` as a compact relative label for the
 * library cards ("just now", "5m ago", "3h ago", "2d ago"), falling back to a
 * locale date once it is more than a week old. `now` is injectable so the
 * thresholds can be pinned in tests without mocking the clock.
 */
export function formatUpdated(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return '';
  }
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(iso).toLocaleDateString();
}
