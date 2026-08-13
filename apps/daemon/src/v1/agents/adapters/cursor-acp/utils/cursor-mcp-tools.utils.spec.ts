import { describe, expect, it } from 'vitest';

import { parseCursorToolsProbe } from './cursor-mcp-tools.utils';

/**
 * Every fixture here is output captured from `cursor-agent mcp list-tools` on
 * 2026.08.11-e8db854, not wording invented for the test — the parser reads prose
 * with no machine-readable mode behind it, so a fixture the CLI never printed
 * would pin nothing.
 */
describe('parseCursorToolsProbe', () => {
  it('reads a server that answered as connected', () => {
    expect(
      parseCursorToolsProbe(
        'Tools for codegraph (1):\n- codegraph_explore (query, maxFiles, projectPath)\n',
      ),
    ).toEqual({ status: 'connected', detail: null });
  });

  it('tells "needs signing in" apart from "broken" — the whole reason stderr is captured', () => {
    // Both of these exit 1 and both are written to stderr, so exit status cannot
    // separate them. Only one of the two gets the user a Sign in button.
    expect(
      parseCursorToolsProbe(
        "MCP 'figma' requires authentication.\nPlease run: agent mcp login figma\n",
      ),
    ).toEqual({ status: 'needs_auth', detail: null });

    expect(
      parseCursorToolsProbe(
        "Failed to list tools: Failed to load MCP 'vercel': Streamable HTTP error: Error POSTing to endpoint\n",
      )?.status,
    ).toBe('failed');
  });

  it('keeps a failure reason to ONE line, so an HTML error page cannot fill the row', () => {
    // Measured: the vercel failure carries the remote's entire error page, and
    // the panel renders `detail` verbatim.
    const health = parseCursorToolsProbe(
      "Failed to list tools: Failed to load MCP 'vercel': <!DOCTYPE html><html>\n<head><title>500</title></head>\n<body>lots more</body>\n",
    );

    expect(health?.detail).toBe(
      "Failed to list tools: Failed to load MCP 'vercel': <!DOCTYPE html><html>",
    );
    expect(health?.detail).not.toContain('lots more');
  });

  it('reads a name no config defines as a failure, not as a state of its own', () => {
    // The panel only ever probes a server its own listing named, so this means
    // the config changed underneath — which is a failure, not a badge to invent.
    expect(
      parseCursorToolsProbe(
        'Failed to list tools: Failed to load MCP \'ghost\': MCP client "ghost" not found in config\n',
      )?.status,
    ).toBe('failed');
  });

  it('answers null for output it does not recognise, rather than calling the server broken', () => {
    // The degrade that matters on a reworded release: a status invented from
    // unrecognised prose would report every server as failed, and the caller
    // leaves the health unstated instead.
    expect(parseCursorToolsProbe('Some entirely new wording\n')).toBeNull();
    expect(parseCursorToolsProbe('')).toBeNull();
    expect(parseCursorToolsProbe(null)).toBeNull();
  });
});
