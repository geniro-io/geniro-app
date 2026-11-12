import { describe, expect, it } from 'vitest';

import { DEFAULT_RESOURCE_ALERT_CONFIG } from '../chat.types';
import {
  conditionKey,
  firingConditions,
  growthPerMinute,
  parseConditionKey,
  type ResourceReading,
  type RssSample,
  sustainedGrowthPerMinute,
  type ThreadReading,
} from './resource-alert-rules';

const GIB = 1024 ** 3;
const config = DEFAULT_RESOURCE_ALERT_CONFIG;

function reading(overrides: Partial<ResourceReading> = {}): ResourceReading {
  return {
    threads: [],
    pressureLevel: 1,
    freeDiskBytes: 100 * GIB,
    ...overrides,
  };
}

function thread(
  rssBytes: number,
  growthBytesPerMinute: number | null = null,
  runId = 'r1',
) {
  return {
    runId,
    rssBytes,
    growthBytesPerMinute,
    sustainedGrowthBytesPerMinute: growthBytesPerMinute,
  };
}

/** Samples every 30 s, the watch's reading interval, up to `endAt`. */
function samplesEvery30s(
  endAt: number,
  rssAt: (seconds: number) => number,
): RssSample[] {
  const samples: RssSample[] = [];
  for (let at = 0; at <= endAt; at += 30_000) {
    samples.push({ at, rssBytes: rssAt(at / 1000) });
  }
  return samples;
}

/** The newest sample becomes `now`; the rest is the history it is read against. */
function split(samples: RssSample[]): {
  history: RssSample[];
  now: RssSample;
} {
  const now = samples[samples.length - 1];
  if (now === undefined) {
    throw new Error('no samples');
  }
  return { history: samples.slice(0, -1), now };
}

function splitTuple(samples: RssSample[]): [RssSample[], RssSample] {
  const { history, now } = split(samples);
  return [history, now];
}

describe('growthPerMinute', () => {
  it('is null until a sample is at least a minute old', () => {
    expect(
      growthPerMinute([{ at: 0, rssBytes: 0 }], { at: 59_999, rssBytes: GIB }),
    ).toBeNull();
  });

  it('measures from the newest sample a minute or more old', () => {
    const history = [
      { at: 0, rssBytes: 0 },
      { at: 30_000, rssBytes: GIB },
      { at: 60_000, rssBytes: 5 * GIB },
    ];
    expect(growthPerMinute(history, { at: 90_000, rssBytes: 4 * GIB })).toBe(
      3 * GIB,
    );
  });

  it('reports shrinking as a negative rate', () => {
    expect(
      growthPerMinute([{ at: 0, rssBytes: 4 * GIB }], {
        at: 120_000,
        rssBytes: 2 * GIB,
      }),
    ).toBe(-GIB);
  });
});

describe('firingConditions', () => {
  const memory = conditionKey('thread-memory', 'r1');
  const growth = conditionKey('thread-growth', 'r1');
  const pressure = conditionKey('memory-pressure');
  const disk = conditionKey('low-disk');

  it('starts a thread-memory condition at the threshold, not below it', () => {
    expect(
      firingConditions(
        config,
        new Set(),
        reading({ threads: [thread(8 * GIB)] }),
      ),
    ).toEqual(new Set([memory]));
    expect(
      firingConditions(
        config,
        new Set(),
        reading({ threads: [thread(8 * GIB - 1)] }),
      ).has(memory),
    ).toBe(false);
  });

  it('holds thread-memory until it falls below 80% of the threshold', () => {
    const held = firingConditions(
      config,
      new Set([memory]),
      reading({ threads: [thread(7 * GIB)] }),
    );
    expect(held.has(memory)).toBe(true);
    const cleared = firingConditions(
      config,
      new Set([memory]),
      reading({ threads: [thread(6 * GIB)] }),
    );
    expect(cleared.has(memory)).toBe(false);
  });

  it('clears a thread condition once the thread has no processes', () => {
    expect(
      firingConditions(config, new Set([memory, growth]), reading()).size,
    ).toBe(0);
  });

  it('starts thread-growth only above the 2 GB floor', () => {
    expect(
      firingConditions(
        config,
        new Set(),
        reading({ threads: [thread(1.5 * GIB, 2 * GIB)] }),
      ).has(growth),
    ).toBe(false);
    expect(
      firingConditions(
        config,
        new Set(),
        reading({ threads: [thread(3 * GIB, GIB)] }),
      ),
    ).toEqual(new Set([growth]));
  });

  it('never starts thread-growth without a measured rate, and keeps one it had', () => {
    expect(
      firingConditions(
        config,
        new Set(),
        reading({ threads: [thread(3 * GIB, null)] }),
      ).has(growth),
    ).toBe(false);
    expect(
      firingConditions(
        config,
        new Set([growth]),
        reading({ threads: [thread(3 * GIB, null)] }),
      ).has(growth),
    ).toBe(true);
  });

  it('clears thread-growth once the rate drops under 80% of the threshold', () => {
    expect(
      firingConditions(
        config,
        new Set([growth]),
        reading({ threads: [thread(3 * GIB, 0.7 * GIB)] }),
      ).has(growth),
    ).toBe(false);
  });

  it('starts memory pressure at critical only, and holds it until normal', () => {
    expect(
      firingConditions(config, new Set(), reading({ pressureLevel: 2 })).has(
        pressure,
      ),
    ).toBe(false);
    expect(
      firingConditions(config, new Set(), reading({ pressureLevel: 4 })).has(
        pressure,
      ),
    ).toBe(true);
    expect(
      firingConditions(
        config,
        new Set([pressure]),
        reading({ pressureLevel: 2 }),
      ).has(pressure),
    ).toBe(true);
    expect(
      firingConditions(
        config,
        new Set([pressure]),
        reading({ pressureLevel: 1 }),
      ).has(pressure),
    ).toBe(false);
  });

  it('starts low disk under the threshold and clears it with a margin', () => {
    expect(
      firingConditions(
        config,
        new Set(),
        reading({ freeDiskBytes: 10 * GIB - 1 }),
      ).has(disk),
    ).toBe(true);
    expect(
      firingConditions(
        config,
        new Set([disk]),
        reading({ freeDiskBytes: 12 * GIB }),
      ).has(disk),
    ).toBe(true);
    expect(
      firingConditions(
        config,
        new Set([disk]),
        reading({ freeDiskBytes: 13 * GIB }),
      ).has(disk),
    ).toBe(false);
  });

  it('never starts a system condition on an unreadable value, and keeps one it had', () => {
    const unknown = reading({ pressureLevel: null, freeDiskBytes: null });
    expect(firingConditions(config, new Set(), unknown).size).toBe(0);
    expect(
      firingConditions(config, new Set([pressure, disk]), unknown),
    ).toEqual(new Set([pressure, disk]));
  });

  it('follows the configured thresholds', () => {
    expect(
      firingConditions(
        { ...config, threadMemoryBytes: 2 * GIB },
        new Set(),
        reading({ threads: [thread(2 * GIB)] }),
      ).has(memory),
    ).toBe(true);
  });
});

function readingOf(samples: RssSample[]): ThreadReading {
  const { history, now } = split(samples);
  return {
    runId: 'r1',
    rssBytes: now.rssBytes,
    growthBytesPerMinute: growthPerMinute(history, now),
    sustainedGrowthBytesPerMinute: sustainedGrowthPerMinute(history, now),
  };
}

describe('sustainedGrowthPerMinute', () => {
  it('is null until three consecutive windows of history exist', () => {
    const rss = (seconds: number) => 2 * GIB + (seconds / 60) * GIB;
    expect(
      sustainedGrowthPerMinute(...splitTuple(samplesEvery30s(120_000, rss))),
    ).toBeNull();
    expect(
      sustainedGrowthPerMinute(...splitTuple(samplesEvery30s(150_000, rss))),
    ).toBeNull();
  });

  it('is the lowest rate across three windows, so one step does not read as growth', () => {
    const rss = (seconds: number) => (seconds < 30 ? 0.1 * GIB : 2.1 * GIB);
    for (let end = 60_000; end <= 300_000; end += 30_000) {
      expect(
        firingConditions(
          config,
          new Set(),
          reading({ threads: [readingOf(samplesEvery30s(end, rss))] }),
        ).has(conditionKey('thread-growth', 'r1')),
      ).toBe(false);
    }
  });

  it('reads steady growth at one GB a minute across three windows as one GB a minute', () => {
    const rss = (seconds: number) => 2 * GIB + (seconds / 60) * GIB;
    expect(
      sustainedGrowthPerMinute(...splitTuple(samplesEvery30s(180_000, rss))),
    ).toBe(GIB);
  });
});

describe('growth conditions over sustained windows', () => {
  const growth = conditionKey('thread-growth', 'r1');

  it('starts thread-growth only once three windows hold the threshold above the floor', () => {
    const rss = (seconds: number) => 2 * GIB + (seconds / 60) * GIB;
    expect(
      firingConditions(
        config,
        new Set(),
        reading({ threads: [readingOf(samplesEvery30s(150_000, rss))] }),
      ).has(growth),
    ).toBe(false);
    expect(
      firingConditions(
        config,
        new Set(),
        reading({ threads: [readingOf(samplesEvery30s(180_000, rss))] }),
      ).has(growth),
    ).toBe(true);
  });

  it('keeps a quiet thread from starting growth, while a held one keeps holding', () => {
    expect(
      firingConditions(
        config,
        new Set(),
        reading({ threads: [thread(3 * GIB, GIB)] }),
        new Set([growth]),
      ).has(growth),
    ).toBe(false);
    expect(
      firingConditions(
        config,
        new Set([growth]),
        reading({ threads: [thread(3 * GIB, 0.9 * GIB)] }),
        new Set([growth]),
      ).has(growth),
    ).toBe(true);
  });
});

describe('condition keys', () => {
  it('round-trip a thread key and a system key', () => {
    expect(parseConditionKey(conditionKey('thread-growth', 'run:1'))).toEqual({
      kind: 'thread-growth',
      scope: 'run:1',
    });
    expect(parseConditionKey(conditionKey('low-disk'))).toEqual({
      kind: 'low-disk',
      scope: 'system',
    });
  });

  it('refuses a key of no known kind', () => {
    expect(() => parseConditionKey('cpu:r1')).toThrow(
      /not a resource condition key/,
    );
  });
});
