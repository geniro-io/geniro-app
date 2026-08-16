/**
 * What the page shows where a figure was never measured.
 *
 * Not "0", and not a blank cell. cursor-agent reports no cost unless its
 * currency is USD, and no cache, thinking or timing figures at all — rendering
 * any of those as zero would state that the work was free, and rendering
 * nothing would look like a rendering bug.
 */
export const NOT_MEASURED = '—';

/** The hover sentence that goes with {@link NOT_MEASURED}. */
export const NOT_MEASURED_TITLE =
  'No agent in this period reported this figure — it was not measured, which is not the same as zero.';

/** The short axis label: `Aug 10`. */
const DAY_LABEL_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
};

/** The hover form: `Monday, 10 August 2026`. */
const DAY_TITLE_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
};

/**
 * Render a `YYYY-MM-DD` bucket key, in the machine's own timezone.
 *
 * Built from PARTS rather than `new Date('2026-08-10')`, which JavaScript reads
 * as UTC midnight and then renders in local time — shifting the label to the
 * previous day for everyone west of Greenwich, so the axis would disagree with
 * the bucket the daemon filed the turns under.
 */
function formatDay(date: string, options: Intl.DateTimeFormatOptions): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) {
    return date;
  }
  return new Date(year, month - 1, day).toLocaleDateString(undefined, options);
}

/** `2026-08-10` → `Aug 10`. */
export function formatDayLabel(date: string): string {
  return formatDay(date, DAY_LABEL_OPTIONS);
}

/** `2026-08-10` → `Monday, 10 August 2026` — the hover form of a column. */
export function formatDayTitle(date: string): string {
  return formatDay(date, DAY_TITLE_OPTIONS);
}

/**
 * A turn count with its noun agreeing: `1 turn`, `2 turns`, `0 turns`.
 *
 * Shared rather than restated at each site because the page renders the same
 * count in two places — the per-day hover sentence and a breakdown legend — and
 * only the first of them agreed, so a one-turn slice read "1 turns".
 */
export function formatTurns(turns: number): string {
  return `${turns} turn${turns === 1 ? '' : 's'}`;
}

/** Working time as a person would say it: `45s`, `12m`, `3h 12m`. */
export function formatDuration(ms: number): string {
  // Tested against the RAW value, not the rounded minute count: 45s rounds to
  // one minute, so a `totalMinutes < 1` guard would report three quarters of a
  // minute as "1m" and the seconds branch would be unreachable.
  if (ms < 60_000) {
    return `${Math.round(ms / 1_000)}s`;
  }
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

/**
 * The share of prompt tokens that came from cache, as a percentage — or null
 * when neither figure was reported.
 *
 * Worth its own line on the page because it is the difference between an
 * expensive session and a cheap one, and it is not readable off either raw
 * count alone.
 */
export function cacheHitRate(
  cacheReadTokens: number | null,
  inputTokens: number | null,
): number | null {
  // The CACHE figure decides it. An unreported cache with real prompt tokens
  // used to divide 0 by them and answer "0%" — stating that nothing was served
  // from cache, which is a measurement cursor-agent never takes (it hard-nulls
  // `cacheReadTokens` while still counting input tokens). A reported 0 against
  // real input tokens IS a measured 0%, and stays one.
  if (cacheReadTokens === null || inputTokens === null) {
    return null;
  }
  const prompt = cacheReadTokens + inputTokens;
  return prompt === 0 ? null : (cacheReadTokens / prompt) * 100;
}
