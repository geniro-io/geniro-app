import { describe, expect, it } from 'vitest';

import { cursorToolCallMetric } from './cursor-tool-metric.utils';

describe('cursorToolCallMetric', () => {
  it('reads the MCP server off cursor’s `<server>-<tool>: <tool>` title', () => {
    expect(
      cursorToolCallMetric(
        'codegraph-codegraph_explore: codegraph_explore',
        null,
      ),
    ).toEqual({ tool: 'codegraph_explore', server: 'codegraph' });
    expect(
      cursorToolCallMetric('geniro-75a31aea-show_chart: show_chart', 'other'),
    ).toEqual({ tool: 'show_chart', server: 'geniro-75a31aea' });
  });

  it('counts its own tools by their ACP kind, never by a title that quotes a command or a path', () => {
    expect(cursorToolCallMetric('`rm -rf build`', 'execute')).toEqual({
      tool: 'execute',
      server: null,
    });
    expect(cursorToolCallMetric('src/app.ts', 'edit')).toEqual({
      tool: 'edit',
      server: null,
    });
    expect(cursorToolCallMetric('Something', null)).toEqual({
      tool: 'other',
      server: null,
    });
  });
});
