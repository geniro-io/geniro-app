import { describe, expect, it } from 'vitest';

import type { ActionOutcomeState } from '../chat.types';
import { foldActions } from './action-fold';

/** Payloads go through `JSON.stringify`: the column is JSON TEXT, and a fold fed objects never proves it parses. */
function publish(
  seq: number,
  actionId: string,
  extra: { once?: boolean; nodeId?: string; label?: string } = {},
): { kind: 'action'; seq: number; payload: string } {
  return {
    kind: 'action',
    seq,
    payload: JSON.stringify({
      actionId,
      label: extra.label ?? actionId,
      once: extra.once ?? true,
      spec: { kind: 'message', text: `${actionId} pressed` },
      publisher: { nodeId: extra.nodeId ?? 'agent', conversationId: '' },
    }),
  };
}

function outcome(
  seq: number,
  actionSeq: number,
  actionId: string,
  state: ActionOutcomeState,
): { kind: 'action_outcome'; seq: number; payload: string } {
  return {
    kind: 'action_outcome',
    seq,
    payload: JSON.stringify({
      actionSeq,
      actionId,
      nodeId: 'agent',
      conversationId: '',
      state,
    }),
  };
}

describe('foldActions', () => {
  it('lists published actions newest first', () => {
    const { live } = foldActions([publish(1, 'a'), publish(2, 'b')]);

    expect(live.map((action) => [action.actionId, action.seq])).toEqual([
      ['b', 2],
      ['a', 1],
    ]);
    expect(live[0]).toMatchObject({ pending: false, label: 'b' });
  });

  it('keeps only the newest publish of a key, and ignores outcomes of the one it replaced', () => {
    const { live, keyOfSeq } = foldActions([
      publish(1, 'a', { label: 'old' }),
      publish(2, 'a', { label: 'new' }),
      outcome(3, 1, 'a', 'dismissed'),
    ]);

    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ seq: 2, label: 'new' });
    expect(keyOfSeq.get(1)).toBe(keyOfSeq.get(2));
  });

  it('scopes an id to its publishing conversation', () => {
    const { live } = foldActions([
      publish(1, 'deploy', { nodeId: 'agent' }),
      publish(2, 'deploy', { nodeId: 'reviewer' }),
    ]);

    expect(live).toHaveLength(2);
  });

  it('marks a pressed action pending and retires a one-shot on success', () => {
    expect(
      foldActions([publish(1, 'a'), outcome(2, 1, 'a', 'pressed')]).live[0],
    ).toMatchObject({ pending: true });
    expect(
      foldActions([
        publish(1, 'a'),
        outcome(2, 1, 'a', 'pressed'),
        outcome(3, 1, 'a', 'succeeded'),
      ]).live,
    ).toEqual([]);
  });

  it('keeps a reusable action live after success and a failed one-shot for retry', () => {
    const reusable = foldActions([
      publish(1, 'a', { once: false }),
      outcome(2, 1, 'a', 'succeeded'),
    ]).live;
    expect(reusable).toHaveLength(1);
    expect(reusable[0]).toMatchObject({
      pending: false,
      lastOutcome: { state: 'succeeded' },
    });

    const failed = foldActions([
      publish(1, 'a'),
      outcome(2, 1, 'a', 'failed'),
    ]).live;
    expect(failed[0]).toMatchObject({ lastOutcome: { state: 'failed' } });
  });

  it('retires a one-shot on interrupted but keeps a reusable one to run again', () => {
    expect(
      foldActions([publish(1, 'a'), outcome(2, 1, 'a', 'interrupted')]).live,
    ).toEqual([]);
    expect(
      foldActions([
        publish(1, 'a', { once: false }),
        outcome(2, 1, 'a', 'interrupted'),
      ]).live,
    ).toMatchObject([{ seq: 1, lastOutcome: { state: 'interrupted' } }]);
  });

  it('never revives a removed publish, whatever outcome follows', () => {
    expect(
      foldActions([
        publish(1, 'a', { once: false }),
        outcome(2, 1, 'a', 'running'),
        outcome(3, 1, 'a', 'removed'),
        outcome(4, 1, 'a', 'failed'),
      ]).live,
    ).toEqual([]);
  });

  it.each(['removed', 'dismissed'] as const)(
    'retires a reusable action on %s',
    (state) => {
      expect(
        foldActions([
          publish(1, 'a', { once: false }),
          outcome(2, 1, 'a', state),
        ]).live,
      ).toEqual([]);
    },
  );

  it('skips a row whose payload does not parse', () => {
    const { live } = foldActions([
      { kind: 'action', seq: 1, payload: '{"actionId":1}' },
      publish(2, 'ok'),
    ]);

    expect(live.map((action) => action.actionId)).toEqual(['ok']);
  });
});
