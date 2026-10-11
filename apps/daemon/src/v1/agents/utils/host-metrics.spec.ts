import { describe, expect, it } from 'vitest';

import { HOST_METRICS_TOOL } from '../chat.types';
import { isHostMetricsCall } from './host-metrics';

const SERVER = 'geniro-1a2b3c4d';

describe('isHostMetricsCall', () => {
  it('matches both CLIs’ spellings of this run’s server', () => {
    expect(
      isHostMetricsCall(SERVER, `mcp__${SERVER}__${HOST_METRICS_TOOL}`),
    ).toBe(true);
    expect(
      isHostMetricsCall(
        SERVER,
        `${SERVER}-${HOST_METRICS_TOOL}: ${HOST_METRICS_TOOL}`,
      ),
    ).toBe(true);
  });

  it('refuses somebody else’s tool of the same name', () => {
    expect(isHostMetricsCall(SERVER, 'mcp__acme__show_metrics')).toBe(false);
    expect(
      isHostMetricsCall(null, `mcp__${SERVER}__${HOST_METRICS_TOOL}`),
    ).toBe(false);
  });
});
