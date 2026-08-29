import { describe, expect, it } from 'vitest';

import {
  HOST_METRICS_TOOL,
  MAX_HOST_METRICS,
  MAX_METRIC_VALUE_LENGTH,
} from '../chat.types';
import {
  hostMetricsResultText,
  isHostMetricsCall,
  readHostMetrics,
} from './host-metrics';

const SERVER = 'geniro-1a2b3c4d';

describe('isHostMetricsCall', () => {
  it('matches both CLIs’ spellings of this run’s server', () => {
    expect(
      isHostMetricsCall(SERVER, `mcp__${SERVER}__${HOST_METRICS_TOOL}`),
    ).toBe(true);
    expect(isHostMetricsCall(SERVER, `${SERVER}: ${HOST_METRICS_TOOL}`)).toBe(
      true,
    );
  });

  it('refuses somebody else’s tool of the same name', () => {
    expect(isHostMetricsCall(SERVER, 'mcp__acme__show_metrics')).toBe(false);
    expect(
      isHostMetricsCall(null, `mcp__${SERVER}__${HOST_METRICS_TOOL}`),
    ).toBe(false);
  });
});

describe('readHostMetrics', () => {
  it('reads a scorecard', () => {
    expect(
      readHostMetrics({
        title: 'After the fix',
        metrics: [
          {
            label: 'Coverage',
            value: '82%',
            delta: '+4 pts',
            sentiment: 'good',
          },
          { label: 'Flaky tests', value: '0', note: 'was 3 last week' },
        ],
      }),
    ).toEqual({
      title: 'After the fix',
      metrics: [
        { label: 'Coverage', value: '82%', delta: '+4 pts', sentiment: 'good' },
        { label: 'Flaky tests', value: '0', note: 'was 3 last week' },
      ],
    });
  });

  it('NEVER coerces a number into a value', () => {
    // The whole point of the string contract: 0.82 renders as "0.82" where the
    // agent meant "82%", and it would be the host's fault while looking like
    // the model's. Dropped, so the agent sees a malformed call and re-sends.
    expect(
      readHostMetrics({ metrics: [{ label: 'Coverage', value: 0.82 }] }),
    ).toBeNull();
  });

  it('drops a row missing either half, and keeps the rest', () => {
    // A figure with no caption cannot be attributed; a caption with no figure
    // measures nothing. Nothing here is positional, so no hole is left.
    const read = readHostMetrics({
      metrics: [
        { label: 'Kept', value: '1' },
        { label: 'No value' },
        { value: '7' },
        null,
        'Coverage: 82%',
        { label: '  ', value: '3' },
        { label: 'Also kept', value: '2' },
      ],
    });
    expect(read?.metrics).toEqual([
      { label: 'Kept', value: '1' },
      { label: 'Also kept', value: '2' },
    ]);
  });

  it('answers a scorecard with nothing on it as NOTHING', () => {
    // The chart's rule, not the findings tool's: an empty findings report is a
    // real review outcome, an empty scorecard is only ever a mistake.
    for (const args of [
      {},
      { metrics: [] },
      { metrics: 'coverage 82%' },
      { metrics: [{ label: 'nothing' }] },
      { title: 'Results', metrics: [{}] },
    ]) {
      expect(readHostMetrics(args)).toBeNull();
    }
  });

  it('drops an unrecognised sentiment rather than colouring by it', () => {
    // It only paints a figure, and a misspelling must never paint a good
    // result red.
    const read = readHostMetrics({
      metrics: [
        {
          label: 'Latency',
          value: '40ms',
          delta: '−12ms',
          sentiment: 'gooood',
        },
      ],
    });
    expect(read?.metrics[0]).toEqual({
      label: 'Latency',
      value: '40ms',
      delta: '−12ms',
    });
  });

  it('TRUNCATES rather than refusing', () => {
    const read = readHostMetrics({
      metrics: Array.from({ length: MAX_HOST_METRICS + 5 }, (_, i) => ({
        label: `m${i}`,
        value: 'x'.repeat(MAX_METRIC_VALUE_LENGTH + 10),
      })),
    });
    expect(read?.metrics).toHaveLength(MAX_HOST_METRICS);
    expect(read?.metrics[0]?.value).toHaveLength(MAX_METRIC_VALUE_LENGTH);
  });

  it('leaves a blank optional absent rather than empty', () => {
    const read = readHostMetrics({
      metrics: [{ label: 'A', value: '1', delta: '   ', note: '' }],
    });
    expect(read?.metrics[0]).toEqual({ label: 'A', value: '1' });
  });
});

describe('hostMetricsResultText', () => {
  it('is a RECEIPT, and tells the agent not to repeat the numbers', () => {
    const text = hostMetricsResultText({ status: 'drawn', count: 4 });
    expect(text).toContain('4 figures');
    expect(text).toContain('Do not repeat the numbers');
  });

  it('counts one figure in the singular', () => {
    expect(hostMetricsResultText({ status: 'drawn', count: 1 })).toContain(
      '1 figure.',
    );
  });

  it('tells an unreachable channel to fall back to words', () => {
    expect(
      hostMetricsResultText({ status: 'unavailable', reason: 'no turn' }),
    ).toContain('no turn');
  });
});
