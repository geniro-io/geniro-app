import { describe, expect, it } from 'vitest';

import {
  codexOneshotFrames,
  codexOneshotReply,
  codexOneshotSettled,
} from './codex-oneshot.utils';

describe('codexOneshotFrames', () => {
  it('writes the handshake, its notification and the request, in that order', () => {
    const frames = codexOneshotFrames('1.2.3', 'thread/list', { limit: 3 }).map(
      (frame) => JSON.parse(frame) as Record<string, unknown>,
    );
    expect(frames.map((frame) => frame.method)).toEqual([
      'initialize',
      'initialized',
      'thread/list',
    ]);
    expect(frames[0]).toMatchObject({
      id: 1,
      params: { clientInfo: { name: 'geniro', version: '1.2.3' } },
    });
    // The notification carries no id; the request takes the next one.
    expect(frames[1]).not.toHaveProperty('id');
    expect(frames[2]).toMatchObject({ id: 2, params: { limit: 3 } });
  });
});

describe('codexOneshotReply', () => {
  const handshakeReply = '{"id":1,"result":{"userAgent":"codex"}}';

  it('waits past the handshake’s own reply for the request’s', () => {
    expect(codexOneshotSettled(`${handshakeReply}\n`)).toBe(false);
    const done = `${handshakeReply}\n{"method":"x","params":{}}\n{"id":2,"result":{"data":[]}}\n`;
    expect(codexOneshotSettled(done)).toBe(true);
    expect(codexOneshotReply(done)).toEqual({ ok: true, result: { data: [] } });
  });

  it('reports the server’s refusal as a refusal', () => {
    expect(
      codexOneshotReply(
        `${handshakeReply}\n{"id":2,"error":{"code":-32600,"message":"no such thread"}}\n`,
      ),
    ).toEqual({ ok: false, message: 'no such thread' });
  });

  it('answers null when codex never replied at all', () => {
    expect(codexOneshotReply(null)).toBeNull();
    expect(codexOneshotReply(`${handshakeReply}\nnot json\n`)).toBeNull();
  });
});
