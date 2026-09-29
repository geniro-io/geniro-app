import { describe, expect, it } from 'vitest';

import { PendingRequests } from './json-rpc-pending.utils';

type Kind = 'initialize' | 'prompt' | 'turn_steer';
type Turn = { name: string };

const first: Turn = { name: 'first' };
const second: Turn = { name: 'second' };

function pendingRequests(): {
  pending: PendingRequests<Kind, Turn>;
  logged: string[];
} {
  const logged: string[] = [];
  return {
    pending: new PendingRequests<Kind, Turn>('test', (message) =>
      logged.push(message),
    ),
    logged,
  };
}

const lands = () => true;
const fails = () => false;

describe('PendingRequests', () => {
  it('numbers requests from 1 and answers the id each went out under', () => {
    const { pending } = pendingRequests();
    expect(pending.send('a', {}, 'initialize', first, lands)).toBe(1);
    expect(pending.send('b', {}, 'prompt', first, lands)).toBe(2);
  });

  it('hands the frame it numbered to the writer', () => {
    const { pending } = pendingRequests();
    let written = '';
    pending.send('session/prompt', { text: 'hi' }, 'prompt', first, (frame) => {
      written = frame;
      return true;
    });
    expect(JSON.parse(written)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { text: 'hi' },
    });
  });

  it('forgets a request whose frame did not go out, and never reuses its id', () => {
    const { pending, logged } = pendingRequests();
    expect(pending.send('a', {}, 'prompt', first, fails)).toBeNull();
    // Nothing is owed a reply to a frame the peer never saw.
    expect(pending.take(1, first)).toBeNull();
    expect(logged).toEqual([]);
    expect(pending.send('b', {}, 'prompt', first, lands)).toBe(2);
  });

  it('gives the entry to the turn that is current, once', () => {
    const { pending } = pendingRequests();
    const id = pending.send('a', {}, 'prompt', first, lands, 'quoted');
    expect(pending.take(id!, first)).toEqual({
      kind: 'prompt',
      turn: first,
      detail: 'quoted',
    });
    expect(pending.take(id!, first)).toBeNull();
  });

  it('answers null, quietly, for an id nothing was sent under', () => {
    const { pending, logged } = pendingRequests();
    expect(pending.take(99, first)).toBeNull();
    expect(logged).toEqual([]);
  });

  it('drops, and logs, a reply owed to a turn that has since ended', () => {
    const { pending, logged } = pendingRequests();
    const id = pending.send('a', {}, 'prompt', first, lands);
    expect(pending.take(id!, second)).toBeNull();
    expect(logged).toEqual([
      'test: dropped the reply to request 1 (prompt) — the turn that sent it has already ended',
    ]);
    // Taken even though it was dropped: a late reply is not waited for twice.
    expect(pending.take(id!, first)).toBeNull();
  });

  it('hands over a stale entry when the kind is one that still matters', () => {
    const { pending, logged } = pendingRequests();
    const steer = pending.send('s', {}, 'turn_steer', first, lands, 'the text');
    const prompt = pending.send('p', {}, 'prompt', first, lands);
    const outlivesItsTurn = (kind: Kind) => kind === 'turn_steer';
    expect(pending.take(steer!, second, outlivesItsTurn)).toEqual({
      kind: 'turn_steer',
      turn: first,
      detail: 'the text',
    });
    // The predicate is per kind: a prompt's reply is still dropped.
    expect(pending.take(prompt!, second, outlivesItsTurn)).toBeNull();
    expect(logged).toHaveLength(1);
  });

  it('registers a frame the caller writes, under the id the frame carries', () => {
    const { pending } = pendingRequests();
    pending.send('a', {}, 'initialize', first, lands);
    const frame = JSON.parse(
      pending.frame('turn/interrupt', { turnId: 't' }, 'prompt', first),
    ) as { id: number; method: string };
    expect(frame).toMatchObject({ id: 2, method: 'turn/interrupt' });
    expect(pending.take(frame.id, first)).toMatchObject({
      kind: 'prompt',
      detail: null,
    });
  });
});
