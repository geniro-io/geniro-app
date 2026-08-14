import { describe, expect, it } from 'vitest';

import {
  mcpReadingKey,
  mcpStatusRequestLine,
  pendingMcpServers,
  readMcpStatusReply,
} from './claude-mcp-ready.utils';

/**
 * A reply as claude 2.1.232 actually wrote it, trimmed to two rows.
 *
 * Transcribed from the probe rather than composed here, because the one thing
 * this parser can get wrong in a way nothing else would catch is the KEY: the
 * rows arrive under `mcpServers`, and reading the more obvious `servers`
 * returns an empty list from every healthy reply — which the gate cannot tell
 * from "discovery has not started", so it would wait out its grace and release
 * exactly as it does today, with no error anywhere.
 */
const REPLY = {
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'geniro-mcp-1',
    response: {
      mcpServers: [
        {
          name: 'playwright',
          status: 'pending',
          config: { command: 'npx', args: ['-y', '@playwright/mcp'] },
          scope: 'user',
        },
        {
          name: 'github',
          status: 'connected',
          config: { type: 'http', url: 'https://api.githubcopilot.com/mcp' },
          scope: 'user',
        },
      ],
    },
  },
};

describe('the mcp_status request', () => {
  it('is one newline-terminated control request naming the poll', () => {
    const line = mcpStatusRequestLine('geniro-mcp-7');

    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: 'control_request',
      request_id: 'geniro-mcp-7',
      request: { subtype: 'mcp_status' },
    });
  });
});

describe('reading an mcp_status reply', () => {
  it('reads the rows the CLI really sends', () => {
    expect(readMcpStatusReply(REPLY, 'geniro-mcp-1')).toEqual([
      { name: 'playwright', status: 'pending' },
      { name: 'github', status: 'connected' },
    ]);
  });

  it('ignores a reply to somebody else’s request', () => {
    // Every `can_use_tool` answer and every `set_permission_mode` ack travels
    // this same dialogue. Claiming one of those as a reading would hand the
    // gate an empty server list and release the prompt on it.
    expect(readMcpStatusReply(REPLY, 'geniro-mcp-2')).toBeNull();
  });

  it('ignores everything that is not a control response at all', () => {
    expect(
      readMcpStatusReply({ type: 'assistant', message: {} }, 'geniro-mcp-1'),
    ).toBeNull();
    expect(readMcpStatusReply(null, 'geniro-mcp-1')).toBeNull();
    expect(readMcpStatusReply('not an object', 'geniro-mcp-1')).toBeNull();
  });

  it('reports a REFUSAL distinctly from an empty reading', () => {
    // The two mean opposite things to the gate — "we will never know" versus
    // "we do not know yet" — so a CLI that does not implement the subtype must
    // not be waited out for the full empty grace on every first message.
    expect(
      readMcpStatusReply(
        {
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: 'geniro-mcp-1',
            error: 'unknown subtype',
          },
        },
        'geniro-mcp-1',
      ),
    ).toBe('refused');
    expect(
      readMcpStatusReply(
        {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'geniro-mcp-1',
            response: { mcpServers: 'not a list' },
          },
        },
        'geniro-mcp-1',
      ),
    ).toBe('refused');
  });

  it('keeps the rows it can read and drops the ones it cannot', () => {
    // A shape drift in one row must not cost the reading — the gate is deciding
    // whether to hold the user's message, and half an answer beats none.
    expect(
      readMcpStatusReply(
        {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'x',
            response: {
              mcpServers: [
                { name: 'ok', status: 'connected' },
                { name: 'nameless' },
                null,
                'garbage',
              ],
            },
          },
        },
        'x',
      ),
    ).toEqual([{ name: 'ok', status: 'connected' }]);
  });

  it('reads an empty list as an empty reading, not a refusal', () => {
    expect(
      readMcpStatusReply(
        {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'x',
            response: { mcpServers: [] },
          },
        },
        'x',
      ),
    ).toEqual([]);
  });
});

describe('the reading’s fingerprint', () => {
  it('carries the STATUS, so a server that connected is a new reading', () => {
    // The gate releases on two IDENTICAL readings. A name-only key would call
    // "playwright pending" and "playwright connected" the same reading and
    // release the prompt in the middle of discovery, which is the defect.
    expect(mcpReadingKey([{ name: 'a', status: 'pending' }])).not.toBe(
      mcpReadingKey([{ name: 'a', status: 'connected' }]),
    );
  });

  it('does not depend on the order the CLI happened to list them in', () => {
    expect(
      mcpReadingKey([
        { name: 'b', status: 'connected' },
        { name: 'a', status: 'connected' },
      ]),
    ).toBe(
      mcpReadingKey([
        { name: 'a', status: 'connected' },
        { name: 'b', status: 'connected' },
      ]),
    );
  });

  it('separates a server appearing from one merely changing state', () => {
    expect(mcpReadingKey([{ name: 'a', status: 'connected' }])).not.toBe(
      mcpReadingKey([
        { name: 'a', status: 'connected' },
        { name: 'b', status: 'connected' },
      ]),
    );
  });
});

describe('which servers are still dialling', () => {
  it('counts only `pending` — a failed or unauthenticated one is settled', () => {
    // Waiting for `needs-auth` to become `connected` would hold every first
    // message for the full deadline on any machine with one signed-out server,
    // and it never will: the user has to sign it in.
    expect(
      pendingMcpServers([
        { name: 'playwright', status: 'pending' },
        { name: 'github', status: 'connected' },
        { name: 'linear', status: 'needs-auth' },
        { name: 'broken', status: 'failed' },
        { name: 'off', status: 'disabled' },
      ]),
    ).toEqual(['playwright']);
  });
});
