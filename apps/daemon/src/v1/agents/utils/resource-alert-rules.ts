import { InternalException } from '@packages/common';

import {
  RESOURCE_ALERT_KINDS,
  type ResourceAlertConfig,
  type ResourceAlertKind,
} from '../chat.types';

export const GROWTH_FLOOR_BYTES = 2 * 1024 ** 3;

/** The shortest span a growth rate is measured over. */
export const GROWTH_WINDOW_MS = 60_000;

/** Consecutive windows a growth rate must hold in before it counts as growth. */
export const GROWTH_SUSTAINED_WINDOWS = 3;

/** How far below its threshold a reading must fall before the alert can fire again. */
export const RE_ARM_RATIO = 0.8;

export const PRESSURE_NORMAL = 1;
export const PRESSURE_CRITICAL = 4;

export interface RssSample {
  at: number;
  rssBytes: number;
}

function newestWindowBase(
  history: readonly RssSample[],
  end: RssSample,
): RssSample | null {
  let base: RssSample | null = null;
  for (const sample of history) {
    if (end.at - sample.at >= GROWTH_WINDOW_MS) {
      base = base === null || sample.at > base.at ? sample : base;
    }
  }
  return base;
}

function ratePerMinute(base: RssSample, end: RssSample): number {
  return Math.round(
    ((end.rssBytes - base.rssBytes) * 60_000) / (end.at - base.at),
  );
}

/**
 * Bytes per minute between the newest sample at least {@link GROWTH_WINDOW_MS}
 * old and now, or null while the history is shorter than that.
 */
export function growthPerMinute(
  history: readonly RssSample[],
  now: RssSample,
): number | null {
  const base = newestWindowBase(history, now);
  return base === null ? null : ratePerMinute(base, now);
}

/**
 * The lowest rate across the last {@link GROWTH_SUSTAINED_WINDOWS} consecutive
 * windows: each window ends where the one before it began, and starts at the
 * newest sample at least {@link GROWTH_WINDOW_MS} before it. A step inside one
 * window therefore never reads as growth. Null while the history cannot fill
 * every window. `history` holds the samples before `now`.
 */
export function sustainedGrowthPerMinute(
  history: readonly RssSample[],
  now: RssSample,
): number | null {
  let end = now;
  let lowest: number | null = null;
  for (let window = 0; window < GROWTH_SUSTAINED_WINDOWS; window += 1) {
    const base = newestWindowBase(history, end);
    if (base === null) {
      return null;
    }
    const rate = ratePerMinute(base, end);
    lowest = lowest === null ? rate : Math.min(lowest, rate);
    end = base;
  }
  return lowest;
}

export interface ThreadReading {
  runId: string;
  rssBytes: number;
  growthBytesPerMinute: number | null;
  sustainedGrowthBytesPerMinute: number | null;
}

export interface ResourceReading {
  threads: readonly ThreadReading[];
  pressureLevel: number | null;
  freeDiskBytes: number | null;
}

export const SYSTEM_SCOPE = 'system';

export function conditionKey(
  kind: ResourceAlertKind,
  scope: string = SYSTEM_SCOPE,
): string {
  return `${kind}:${scope}`;
}

export function parseConditionKey(key: string): {
  kind: ResourceAlertKind;
  scope: string;
} {
  const at = key.indexOf(':');
  const kind = RESOURCE_ALERT_KINDS.find((each) => each === key.slice(0, at));
  if (at < 0 || kind === undefined) {
    throw new InternalException(
      'RESOURCE_CONDITION_KEY_INVALID',
      `not a resource condition key: ${key}`,
    );
  }
  return { kind, scope: key.slice(at + 1) };
}

/**
 * Which conditions hold after this reading. A condition starts at its
 * threshold and holds until the reading clears it by the re-arm margin, so a
 * value hovering at the line fires once. A reading that could not be taken
 * leaves its condition as it was, and never starts one. A key in `quiet` does
 * not start, though one already held keeps holding.
 */
export function firingConditions(
  config: ResourceAlertConfig,
  previous: ReadonlySet<string>,
  reading: ResourceReading,
  quiet: ReadonlySet<string> = new Set(),
): Set<string> {
  const firing = new Set<string>();
  const hold = (
    key: string,
    starts: boolean | null,
    holds: boolean | null,
  ): void => {
    const was = previous.has(key);
    const mayStart = !quiet.has(key) && (starts ?? false);
    if (was ? (holds ?? true) : mayStart) {
      firing.add(key);
    }
  };
  for (const thread of reading.threads) {
    hold(
      conditionKey('thread-memory', thread.runId),
      thread.rssBytes >= config.threadMemoryBytes,
      thread.rssBytes >= config.threadMemoryBytes * RE_ARM_RATIO,
    );
    const growth = thread.sustainedGrowthBytesPerMinute;
    hold(
      conditionKey('thread-growth', thread.runId),
      growth === null
        ? null
        : growth >= config.growthBytesPerMinute &&
            thread.rssBytes >= GROWTH_FLOOR_BYTES,
      growth === null
        ? null
        : growth >= config.growthBytesPerMinute * RE_ARM_RATIO,
    );
  }
  const level = reading.pressureLevel;
  hold(
    conditionKey('memory-pressure'),
    level === null ? null : level >= PRESSURE_CRITICAL,
    level === null ? null : level > PRESSURE_NORMAL,
  );
  const free = reading.freeDiskBytes;
  hold(
    conditionKey('low-disk'),
    free === null ? null : free < config.minFreeDiskBytes,
    free === null ? null : free < config.minFreeDiskBytes / RE_ARM_RATIO,
  );
  return firing;
}
