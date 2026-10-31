/** `1.2 MB`, or nothing at all for a size that could not be read. */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || bytes < 0) {
    return null;
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 10 and none above it: `9.4 MB` is worth the digit,
  // `847.3 MB` is three characters of noise on a row that has to fit a name.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
