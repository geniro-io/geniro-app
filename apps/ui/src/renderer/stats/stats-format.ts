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
 * The calendar day an ISO instant falls on, in the machine's own timezone.
 *
 * TWIN PARSER: `localDateKey` in `apps/daemon/src/v1/stats/utils/usage-fold.ts`.
 * The two must agree on which day a moment falls on, and there is no shared
 * type spanning them — a change here MUST be mirrored there. This exists
 * rather than `iso.slice(0, 10)`: that slice reads the UTC day, while every
 * bucket on the page is a LOCAL one. The two disagree for anyone off UTC, and
 * the span under the title was reading the wrong end of the disagreement —
 * measured here (UTC+5) on the Today period, whose start is a local midnight
 * and therefore the PREVIOUS UTC day: the header said "August 20 – August 21"
 * over a chart holding one column labelled Aug 21.
 */
function localDayKey(iso: string): string {
  const at = new Date(iso);
  const month = `${at.getMonth() + 1}`.padStart(2, '0');
  const day = `${at.getDate()}`.padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}`;
}

/**
 * The period's span under the page title, as one day or as two.
 *
 * Takes the daemon's ISO bounds rather than day keys, because reading a day out
 * of an instant is the part that has to be got right once — see
 * {@link localDayKey}. With the CALLER slicing them, the comparison and the two
 * renderings each had their own copy of that mistake.
 *
 * A one-day span is stated ONCE: printed as a range it dashed a date to itself,
 * which is a range that is not one and invites reading its halves as two
 * different days. Reachable on every period, not only Today — the daemon clamps
 * a request to what its ledger holds, so a first-day install answers "90 days"
 * with one.
 */
export function dayRangeTitle(fromIso: string, toIso: string): string {
  const from = localDayKey(fromIso);
  const to = localDayKey(toIso);
  return from === to
    ? formatDayTitle(from)
    : `${formatDayTitle(from)} – ${formatDayTitle(to)}`;
}

/**
 * A plain count, grouped: `4`, `1,882`.
 *
 * The turn count is the one figure on this page that was `String(n)`, so beside
 * a grouped `$21,547.80` it read as an unformatted number rather than as a
 * deliberate one. Grouped in the same notation as the money, for the reason
 * `formatUsd` records: the digits are the app's, not the locale's.
 */
const COUNT = new Intl.NumberFormat('en-US');

export function formatCount(value: number): string {
  return COUNT.format(value);
}

/**
 * A rate, as a percentage — and never rounded UP to a whole it did not reach.
 *
 * Measured on a real ledger, the cache hit rate is 16.6e9 / (16.6e9 + 155e3) =
 * 99.999%, which `Math.round` printed as `100%`: a claim that every prompt
 * token in the period came from cache and not one was ever a miss. It is the
 * kind of figure a reader stops trusting the page over, because they know it
 * cannot be true. So a rate short of the whole keeps a decimal until it says
 * something short of the whole, and only a genuine 100 prints as `100%`.
 */
export function formatPercent(rate: number): string {
  const rounded = Math.round(rate);
  if (rounded === 100 && rate < 100) {
    return '99.9%';
  }
  if (rounded === 0 && rate > 0) {
    return '<1%';
  }
  return `${rounded}%`;
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

/**
 * Money at axis size: `$0`, `$500`, `$1.5k`, `$12k`.
 *
 * The full `formatUsd` is right for a figure someone is reading, and wrong for
 * a tick: five ticks of `$1500.00` is a column of noise wider than the plot it
 * labels. Tooltips keep the exact value, so nothing is lost by rounding here.
 */
export function formatUsdAxis(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1_000) {
    // No decimals: an axis step is a round number by construction, and `$12.50`
    // beside `$25.00` invites the reader to look for a precision the tick does
    // not have.
    return `$${Math.round(value)}`;
  }
  const thousands = value / 1_000;
  // One decimal below 10k (`$1.5k` is a useful distinction), none above, where
  // it would be false precision on a tick.
  return `$${abs < 10_000 ? Number(thousands.toFixed(1)) : Math.round(thousands)}k`;
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
