import { describe, expect, it } from 'vitest';

import {
  classifyMessage,
  decodeRequestId,
  encodeError,
  encodeRequest,
  encodeRequestId,
  encodeResult,
  JSONRPC_METHOD_NOT_FOUND,
  replyIdOfPrefix,
} from './json-rpc.utils';

describe('classifyMessage', () => {
  it('reads a reply carrying a result', () => {
    expect(
      classifyMessage({ jsonrpc: '2.0', id: 3, result: { ok: true } }),
    ).toEqual({ kind: 'response', id: 3, result: { ok: true } });
  });

  it('treats a null result as a successful reply, not an unknown message', () => {
    // ACP acks several requests with `result: null`; keying on truthiness would
    // strand the pending request forever and hang the turn.
    expect(classifyMessage({ id: 'a', result: null })).toEqual({
      kind: 'response',
      id: 'a',
      result: null,
    });
  });

  it('reads an error reply and keeps its message', () => {
    expect(
      classifyMessage({
        id: 1,
        error: { code: -32602, message: 'bad params' },
      }),
    ).toEqual({ kind: 'error', id: 1, message: 'bad params' });
  });

  it('keeps the detail under `data`, which is the only part that names anything', () => {
    // Measured against cursor-agent 2026.08.11-e8db854: a refused effort answers
    // `{code:-32602, message:"Invalid params", data:{message:"Invalid value for
    // effort: max"}}`. The top-level message is the JSON-RPC CATEGORY, spelled
    // identically for every bad parameter, so reading it alone put the words
    // `Invalid params` in the transcript and nothing a user could act on.
    expect(
      classifyMessage({
        id: 1,
        error: {
          code: -32602,
          message: 'Invalid params',
          data: { message: 'Invalid value for effort: max' },
        },
      }),
    ).toEqual({
      kind: 'error',
      id: 1,
      message: 'Invalid params: Invalid value for effort: max',
    });
  });

  it('keeps a thrown error’s text, which the ACP SDK puts under `data.details`', () => {
    // cursor-agent 2026.10.19-6bbf2c4, its connection cut while the
    // background-task drain streamed: the reply verbatim.
    expect(
      classifyMessage({
        id: 1,
        error: {
          code: -32603,
          message: 'Internal error',
          data: { details: '[aborted] read ECONNRESET' },
        },
      }),
    ).toEqual({
      kind: 'error',
      id: 1,
      message: 'Internal error: [aborted] read ECONNRESET',
    });
  });

  it('keeps a detail the SDK handed back as a bare JSON string', () => {
    expect(
      classifyMessage({
        id: 1,
        error: {
          code: -32603,
          message: 'Internal error',
          data: 'stream reset',
        },
      }),
    ).toEqual({
      kind: 'error',
      id: 1,
      message: 'Internal error: stream reset',
    });
  });

  it('does not say the same thing twice when the detail repeats the category', () => {
    expect(
      classifyMessage({
        id: 1,
        error: {
          code: -32602,
          message: 'bad params',
          data: { message: 'bad params' },
        },
      }),
    ).toEqual({ kind: 'error', id: 1, message: 'bad params' });
  });

  it('falls back to the code when an error reply carries no message', () => {
    expect(classifyMessage({ id: 1, error: { code: -32000 } })).toEqual({
      kind: 'error',
      id: 1,
      message: 'json-rpc error -32000',
    });
  });

  it('distinguishes an agent request from a notification by the id', () => {
    expect(
      classifyMessage({
        id: 7,
        method: 'session/request_permission',
        params: {},
      }),
    ).toEqual({
      kind: 'request',
      id: 7,
      method: 'session/request_permission',
      params: {},
    });
    expect(
      classifyMessage({ method: 'session/update', params: { a: 1 } }),
    ).toEqual({
      kind: 'notification',
      method: 'session/update',
      params: { a: 1 },
    });
  });

  it('rejects a non-serializable id rather than replying to one that cannot round-trip', () => {
    // A NaN id cannot be written back out, so answering it would park the agent
    // on a reply it never matches.
    expect(classifyMessage({ id: Number.NaN, result: 1 })).toEqual({
      kind: 'unknown',
    });
  });

  it('degrades unrecognized shapes to unknown instead of throwing', () => {
    expect(classifyMessage(null).kind).toBe('unknown');
    expect(classifyMessage('a string').kind).toBe('unknown');
    expect(classifyMessage([1, 2]).kind).toBe('unknown');
    expect(classifyMessage({ id: 1 }).kind).toBe('unknown');
  });
});

describe('replyIdOfPrefix', () => {
  it('reads the id of a reply from its first characters', () => {
    expect(
      replyIdOfPrefix('{"id":2,"result":{"thread":{"id":"t","turns":['),
    ).toBe(2);
    expect(
      replyIdOfPrefix('{"jsonrpc":"2.0","id":"a\\"b","error":{"code"'),
    ).toBe('a"b');
    expect(replyIdOfPrefix('{"id":7,"jsonrpc":"2.0","result":null')).toBe(7);
  });

  it('reads no id from a request, a notification or a cut-off id', () => {
    expect(
      replyIdOfPrefix('{"id":4,"method":"item/tool/call","params":{'),
    ).toBeNull();
    expect(replyIdOfPrefix('{"method":"item/completed","params":{')).toBeNull();
    expect(replyIdOfPrefix('{"id":123')).toBeNull();
    expect(replyIdOfPrefix('{"result":{"id":2},"id":2')).toBeNull();
  });
});

describe('encoders', () => {
  it('frames one newline-terminated JSON-RPC 2.0 message per call', () => {
    const line = encodeRequest(1, 'initialize', { protocolVersion: 1 });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1 },
    });
  });

  it('encodes results and errors', () => {
    expect(JSON.parse(encodeResult('x', { outcome: 'ok' }))).toEqual({
      jsonrpc: '2.0',
      id: 'x',
      result: { outcome: 'ok' },
    });
    expect(
      JSON.parse(encodeError(2, JSONRPC_METHOD_NOT_FOUND, 'nope')),
    ).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32601, message: 'nope' },
    });
  });
});

describe('request id tagging', () => {
  it('round-trips a numeric id back to a number', () => {
    const encoded = encodeRequestId(42);
    expect(typeof encoded).toBe('string');
    expect(decodeRequestId(encoded)).toBe(42);
  });

  it('round-trips a string id back to a string', () => {
    expect(decodeRequestId(encodeRequestId('req-9'))).toBe('req-9');
  });

  it('keeps a numeric-looking string a string', () => {
    // The whole point of the tag: replying with "7" to an agent that sent 7 is
    // an unmatched reply, and the agent stays parked.
    expect(decodeRequestId(encodeRequestId('7'))).toBe('7');
    expect(decodeRequestId(encodeRequestId(7))).toBe(7);
  });

  it('rejects an untagged or malformed id', () => {
    expect(decodeRequestId('7')).toBeNull();
    expect(decodeRequestId('n:not-a-number')).toBeNull();
  });
});
