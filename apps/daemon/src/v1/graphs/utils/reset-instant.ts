/**
 * The INSTANT a usage window reopens, read from the sentence a CLI wrote about
 * it — or null when the sentence does not say it precisely enough to wait for.
 *
 * `CalleeTurnOutcome.resetsAt` is kept verbatim on purpose: it is shown to a
 * model and a person, and a parse that went wrong must not change what they
 * read. This is the one reader that turns it into a time, and it exists for a
 * single job — waking the caller when the window reopens. REPORTED on a Dev
 * Team run whose Engineer hit `You've hit your session limit · resets 6:10pm
 * (Asia/Almaty)` at 11:36 UTC: nothing woke the Manager at the reset, so it set
 * itself a `sleep 5300` in a background shell to do it, and the team sat idle
 * for 2h23m in all.
 *
 * The shapes are claude's own formatter (`Pc` in the 2.1.280 bundle), read
 * rather than guessed: within a day it prints `toLocaleTimeString('en-US',
 * {hour:'numeric', minute:'2-digit' unless :00, hour12:true})` with the
 * meridiem lowercased — `6:10pm`, `6pm`; further out it prints the date too —
 * `Sep 25, 6pm`, and `Jan 2, 2027, 9:30am` across a year boundary — and it
 * always appends the IANA zone it formatted in, ` (Asia/Almaty)`. A sentence
 * with no zone is read in the machine's own zone, which is the one the CLI
 * formats in when it prints none.
 *
 * A time with no date is the NEXT such time: `6pm` read at 19:00 is tomorrow.
 */
const RESET_PATTERN =
  /^(?:(?<month>[A-Z][a-z]{2}) (?<day>\d{1,2}),(?: (?<year>\d{4}),)? )?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)(?:\s*\((?<zone>[^)]+)\))?$/i;

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

const DAY_MS = 24 * 60 * 60 * 1000;

export function resetInstantFrom(resetsAt: string, now: Date): number | null {
  const match = RESET_PATTERN.exec(resetsAt.trim());
  const groups = match?.groups;
  if (!groups) {
    return null;
  }
  const hour12 = Number(groups.hour);
  const minute = groups.minute === undefined ? 0 : Number(groups.minute);
  if (hour12 < 1 || hour12 > 12 || minute > 59) {
    return null;
  }
  const hour =
    (hour12 % 12) + (groups.meridiem!.toLowerCase() === 'pm' ? 12 : 0);
  const zone =
    groups.zone?.trim() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = wallDate(now.getTime(), zone);
  if (today === null) {
    return null; // a zone Intl does not know
  }
  if (groups.month !== undefined) {
    const month = MONTHS.indexOf(groups.month.toLowerCase());
    const day = Number(groups.day);
    if (month < 0 || day < 1 || day > 31) {
      return null;
    }
    const year = groups.year === undefined ? today.year : Number(groups.year);
    let instant = zonedToUtc(year, month, day, hour, minute, zone);
    // `Jan 2, 9am` read on Dec 30 without a year is next year's.
    if (groups.year === undefined && instant < now.getTime() - DAY_MS) {
      instant = zonedToUtc(year + 1, month, day, hour, minute, zone);
    }
    return instant;
  }
  const instant = zonedToUtc(
    today.year,
    today.month,
    today.day,
    hour,
    minute,
    zone,
  );
  return instant <= now.getTime()
    ? zonedToUtc(today.year, today.month, today.day + 1, hour, minute, zone)
    : instant;
}

/** The calendar date `at` falls on in `zone`, or null for an unknown zone. */
function wallDate(
  at: number,
  zone: string,
): { year: number; month: number; day: number } | null {
  try {
    const parts = partsOf(at, zone);
    return { year: parts.year, month: parts.month, day: parts.day };
  } catch {
    return null;
  }
}

/**
 * The UTC instant of a wall-clock time in `zone`. Two passes, because the
 * zone's offset is a property of the instant being computed: the first guess
 * can land on the other side of a DST change from the answer.
 */
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  const first = wall - offsetOf(wall, zone);
  const second = wall - offsetOf(first, zone);
  return second;
}

/** How far `zone`'s wall clock is ahead of UTC at `at`, in milliseconds. */
function offsetOf(at: number, zone: string): number {
  const parts = partsOf(at, zone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

function partsOf(
  at: number,
  zone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const read = new Map(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const num = (key: Intl.DateTimeFormatPartTypes): number =>
    Number(read.get(key));
  return {
    year: num('year'),
    month: num('month') - 1,
    day: num('day'),
    hour: num('hour'),
    minute: num('minute'),
    second: num('second'),
  };
}
