import { describe, expect, it } from 'vitest';

import { DEFAULT_RESOURCE_ALERT_CONFIG } from '../chat.types';
import {
  conditionKey,
  firingConditions,
  growthPerMinute,
  parseConditionKey,
  type ResourceReading,
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
  return { runId, rssBytes, growthBytesPerMinute };
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
