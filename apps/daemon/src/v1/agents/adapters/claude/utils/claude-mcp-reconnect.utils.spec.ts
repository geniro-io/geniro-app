import { describe, expect, it } from 'vitest';

import { CLAUDE_MCP_RECONNECT_SUBTYPE } from '../claude.const';
import {
  mcpReconnectRequestLine,
  notConnectedMcpServer,
  readMcpReconnectReply,
} from './claude-mcp-reconnect.utils';

/** One tool result, as the CLI writes it back into the conversation. */
const toolResult = (content: unknown, isError = true): unknown => ({
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content,
        ...(isError ? { is_error: true } : {}),
      },
    ],
  },
});

describe('mcpReconnectRequestLine', () => {
  it('writes the probed control-request shape, newline-terminated', () => {
    const line = mcpReconnectRequestLine('r-1', 'claude.ai Datadog');

    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({
      type: 'control_request',
      request_id: 'r-1',
      request: {
        subtype: CLAUDE_MCP_RECONNECT_SUBTYPE,
        serverName: 'claude.ai Datadog',
      },
    });
  });
});

describe('readMcpReconnectReply', () => {
  it('reads the success reply as "no error"', () => {
    // Byte-for-byte the reply the working profile answered on 2.1.247.
    const reply = readMcpReconnectReply(
      {
        type: 'control_response',
        response: { subtype: 'success', request_id: 'r-1' },
      },
      'r-1',
    );

    expect(reply).toEqual({ error: null });
  });

  it("carries the CLI's own reason verbatim on a failure", () => {
    const error =
      'Error POSTing to endpoint: {"type":"error","error":{"type":"not_found_error","message":"Server not found"}}';

    expect(
      readMcpReconnectReply(
        {
          type: 'control_response',
          response: { subtype: 'error', request_id: 'r-1', error },
        },
        'r-1',
      ),
    ).toEqual({ error });
  });

  it('never reports a reasonless failure as a success', () => {
    // The `error` arm must stay distinguishable from `{error: null}` even when
    // the CLI says nothing — null is what MEANS success here.
    expect(
      readMcpReconnectReply(
        {
          type: 'control_response',
          response: { subtype: 'error', request_id: 'r-1' },
        },
        'r-1',
      ),
    ).toEqual({ error: 'error' });
  });

  it('ignores a reply to some other request, and non-replies', () => {
    const other = {
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r-2' },
    };

    expect(readMcpReconnectReply(other, 'r-1')).toBeNull();
    expect(readMcpReconnectReply({ type: 'assistant' }, 'r-1')).toBeNull();
    expect(readMcpReconnectReply(null, 'r-1')).toBeNull();
  });
});

describe('notConnectedMcpServer', () => {
  it('names the server from the failing tool result', () => {
    expect(
      notConnectedMcpServer(
        toolResult(
          'MCP server "claude.ai Example Google Workspace" is not connected',
        ),
      ),
    ).toBe('claude.ai Example Google Workspace');
  });

  it('reads the sentence out of a text block too', () => {
    expect(
      notConnectedMcpServer(
        toolResult([
          { type: 'text', text: 'MCP server "linear" is not connected' },
        ]),
      ),
    ).toBe('linear');
  });

  it('does not fire on the sentence merely being QUOTED by another tool', () => {
    // The pattern is spelled out in `claude.const.ts`, so every `Read` of this
    // adapter's own source carries it. `isPermissionChannelFailure` shipped the
    // substring version of this bug and it reached the user three times.
    // `is_error` is deliberately TRUE here — a failed `grep`/`Bash` echoing the
    // line it matched is exactly that — so the anchoring is the only thing that
    // can save this case, and the test fails the moment the match loosens.
    const quotingTheSource = toolResult(
      'const CLAUDE_MCP_NOT_CONNECTED_PATTERN = /^MCP server "(.+)" is not connected$/;',
    );

    expect(notConnectedMcpServer(quotingTheSource)).toBeNull();
  });

  it('requires the failure flag, not just the sentence', () => {
    expect(
      notConnectedMcpServer(
        toolResult('MCP server "linear" is not connected', false),
      ),
    ).toBeNull();
  });

  it('ignores every other line', () => {
    expect(notConnectedMcpServer({ type: 'assistant' })).toBeNull();
    expect(notConnectedMcpServer(toolResult('File written'))).toBeNull();
    expect(notConnectedMcpServer(undefined)).toBeNull();
  });
});
