import { describe, expect, it } from 'vitest';

import { HOST_CHART_TOOL } from '../chat.types';
import { isHostChartCall } from './host-chart';

const SERVER = 'geniro-1a2b3c4d';

describe('isHostChartCall', () => {
  it("matches claude's spelling, which wraps the per-run server name", () => {
    expect(isHostChartCall(SERVER, `mcp__${SERVER}__${HOST_CHART_TOOL}`)).toBe(
      true,
    );
  });

  it('matches cursor’s measured title, `<server>-<tool>: <tool>`', () => {
    expect(
      isHostChartCall(
        SERVER,
        `${SERVER}-${HOST_CHART_TOOL}: ${HOST_CHART_TOOL}`,
      ),
    ).toBe(true);
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
