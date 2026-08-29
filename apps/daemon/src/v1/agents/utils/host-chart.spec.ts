import { describe, expect, it } from 'vitest';

import {
  HOST_CHART_TOOL,
  MAX_CHART_LABEL_LENGTH,
  MAX_CHART_POINTS,
  MAX_CHART_SERIES,
} from '../chat.types';
import {
  hostChartResultText,
  isHostChartCall,
  readHostChart,
} from './host-chart';

const SERVER = 'geniro-1a2b3c4d';

function chart(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Test suite duration',
    kind: 'line',
    x_label: 'commit',
    y_label: 'seconds',
    labels: ['a1b2', 'c3d4', 'e5f6'],
    series: [{ name: 'unit', values: [12.1, 13.4, 11.9] }],
    ...overrides,
  };
}

describe('isHostChartCall', () => {
  it("matches claude's spelling, which wraps the per-run server name", () => {
    expect(isHostChartCall(SERVER, `mcp__${SERVER}__${HOST_CHART_TOOL}`)).toBe(
      true,
    );
  });

  it("matches cursor's prose rendering of server and tool together", () => {
    expect(isHostChartCall(SERVER, `${SERVER}: ${HOST_CHART_TOOL}`)).toBe(true);
  });

  it('refuses a same-named tool on somebody else’s server', () => {
    // A user's own MCP server may legitimately expose a `show_chart`, and it
    // must not inherit this app's auto-approval.
    expect(isHostChartCall(SERVER, `acme-viz: ${HOST_CHART_TOOL}`)).toBe(false);
    expect(isHostChartCall(SERVER, 'mcp__acme__show_chart')).toBe(false);
  });

  it('refuses every spelling when no host server was minted for this run', () => {
    expect(isHostChartCall(null, `mcp__${SERVER}__${HOST_CHART_TOOL}`)).toBe(
      false,
    );
  });

  it('does not match geniro’s other host tools', () => {
    expect(isHostChartCall(SERVER, `${SERVER}: report_findings`)).toBe(false);
    expect(isHostChartCall(SERVER, `${SERVER}: ask_user_question`)).toBe(false);
  });
});

describe('readHostChart', () => {
  it('reads a well-formed call, crossing the snake_case seam', () => {
    expect(readHostChart(chart())).toEqual({
      title: 'Test suite duration',
      kind: 'line',
      xLabel: 'commit',
      yLabel: 'seconds',
      labels: ['a1b2', 'c3d4', 'e5f6'],
      series: [{ name: 'unit', values: [12.1, 13.4, 11.9] }],
    });
  });

  it('KEEPS a chart with no title, minus that one field', () => {
    // The tool advertises `title` as required, but a plot of real numbers is
    // worth drawing under a generic heading.
    const read = readHostChart(chart({ title: undefined }));
    expect(read).not.toHaveProperty('title');
    expect(read?.series).toHaveLength(1);
  });

  it('falls back to a line for an unknown kind rather than losing the plot', () => {
    expect(readHostChart(chart({ kind: 'sunburst' }))?.kind).toBe('line');
    expect(readHostChart(chart({ kind: undefined }))?.kind).toBe('line');
  });

  it('keeps each declared kind', () => {
    expect(readHostChart(chart({ kind: 'bar' }))?.kind).toBe('bar');
    expect(readHostChart(chart({ kind: 'area' }))?.kind).toBe('area');
  });

  it('returns null when there are no labels to plot against', () => {
    expect(readHostChart(chart({ labels: [] }))).toBeNull();
    expect(readHostChart(chart({ labels: 'three' }))).toBeNull();
    expect(readHostChart({ series: chart().series })).toBeNull();
  });

  it('returns null when nothing survives as a series', () => {
    expect(readHostChart(chart({ series: [] }))).toBeNull();
    expect(readHostChart(chart({ series: 'unit' }))).toBeNull();
    expect(readHostChart({ labels: ['a'] })).toBeNull();
  });

  it('drops a nameless series — it could never appear in the legend', () => {
    expect(
      readHostChart(chart({ series: [{ values: [1, 2, 3] }] })),
    ).toBeNull();
  });

  it('drops a series with no measured point at all, keeping its neighbours', () => {
    const read = readHostChart(
      chart({
        series: [
          { name: 'empty', values: [null, null, null] },
          { name: 'unit', values: [1, 2, 3] },
        ],
      }),
    );
    expect(read?.series.map((s) => s.name)).toEqual(['unit']);
  });

  it('PADS a short series with gaps rather than shifting its points left', () => {
    // The whole positional contract: index i is always the label at index i.
    const read = readHostChart(
      chart({ series: [{ name: 'unit', values: [12.1] }] }),
    );
    expect(read?.series[0]?.values).toEqual([12.1, null, null]);
  });

  it('cuts a series longer than the labels', () => {
    const read = readHostChart(
      chart({ series: [{ name: 'unit', values: [1, 2, 3, 4, 5] }] }),
    );
    expect(read?.series[0]?.values).toEqual([1, 2, 3]);
  });

  it('blanks an unreadable LABEL instead of removing it', () => {
    // Removing one would re-attribute every measurement after it — the failure
    // this rule exists to prevent, because the result still looks like a chart.
    const read = readHostChart(
      chart({ labels: ['a1b2', { nope: true }, 'e5f6'] }),
    );
    expect(read?.labels).toEqual(['a1b2', '', 'e5f6']);
    expect(read?.series[0]?.values).toEqual([12.1, 13.4, 11.9]);
  });

  it('stringifies a numeric label — years and run numbers arrive unquoted', () => {
    expect(
      readHostChart(chart({ labels: [2024, 2025, 2026] }))?.labels,
    ).toEqual(['2024', '2025', '2026']);
  });

  it('accepts a quoted number, which a model does send', () => {
    const read = readHostChart(
      chart({ series: [{ name: 'unit', values: ['12.1', '13.4', '11.9'] }] }),
    );
    expect(read?.series[0]?.values).toEqual([12.1, 13.4, 11.9]);
  });

  it.each([[''], [' '], [null], [{}], ['n/a'], [true]])(
    'reads %p as a GAP, never as zero',
    (value) => {
      const read = readHostChart(
        chart({ series: [{ name: 'unit', values: [1, value, 3] }] }),
      );
      expect(read?.series[0]?.values).toEqual([1, null, 3]);
    },
  );

  it('reads a non-finite number as a gap — it has no position on an axis', () => {
    const read = readHostChart(
      chart({
        series: [{ name: 'unit', values: [1, Number.POSITIVE_INFINITY, 3] }],
      }),
    );
    expect(read?.series[0]?.values).toEqual([1, null, 3]);
  });

  it('keeps a real zero, which IS a measurement', () => {
    const read = readHostChart(
      chart({ series: [{ name: 'unit', values: [0, 2, 3] }] }),
    );
    expect(read?.series[0]?.values).toEqual([0, 2, 3]);
  });

  it('keeps a negative number — a delta is a legitimate plot', () => {
    const read = readHostChart(
      chart({ series: [{ name: 'delta', values: [-3, 2, -1] }] }),
    );
    expect(read?.series[0]?.values).toEqual([-3, 2, -1]);
  });

  it('truncates past the series cap rather than refusing the chart', () => {
    const read = readHostChart(
      chart({
        series: Array.from({ length: MAX_CHART_SERIES + 3 }, (_, i) => ({
          name: `s${i}`,
          values: [1, 2, 3],
        })),
      }),
    );
    expect(read?.series).toHaveLength(MAX_CHART_SERIES);
  });

  it('truncates past the point cap, cutting the series to match', () => {
    const long = Array.from(
      { length: MAX_CHART_POINTS + 10 },
      (_, i) => `${i}`,
    );
    const read = readHostChart(
      chart({
        labels: long,
        series: [{ name: 'unit', values: long.map((_, i) => i) }],
      }),
    );
    expect(read?.labels).toHaveLength(MAX_CHART_POINTS);
    expect(read?.series[0]?.values).toHaveLength(MAX_CHART_POINTS);
  });

  it('truncates an over-long label to its cap', () => {
    const read = readHostChart(chart({ labels: ['x'.repeat(200), 'b', 'c'] }));
    expect(read?.labels[0]).toHaveLength(MAX_CHART_LABEL_LENGTH);
  });

  it('skips a non-object series entry without losing its neighbours', () => {
    const read = readHostChart(
      chart({ series: [null, 'unit', { name: 'unit', values: [1, 2, 3] }] }),
    );
    expect(read?.series).toHaveLength(1);
  });
});

describe('hostChartResultText', () => {
  it('is a receipt, never the numbers', () => {
    // Echoing the series would put every point into the model's window twice.
    const text = hostChartResultText({
      status: 'drawn',
      series: 2,
      points: 30,
    });
    expect(text).toBe('Chart drawn for the user: 2 series over 30 points.');
    expect(text).not.toContain('12.1');
  });

  it('says one point in the singular, and leaves "series" alone', () => {
    expect(hostChartResultText({ status: 'drawn', series: 1, points: 1 })).toBe(
      'Chart drawn for the user: 1 series over 1 point.',
    );
  });

  it('names the reason when the chart could not be drawn', () => {
    const text = hostChartResultText({
      status: 'unavailable',
      reason: 'no turn is running that could draw it',
    });
    expect(text).toContain('no turn is running that could draw it');
    expect(text).toContain('in your reply');
  });
});
