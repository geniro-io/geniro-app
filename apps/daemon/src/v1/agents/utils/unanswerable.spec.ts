import { describe, expect, it } from 'vitest';

import type { Item } from '../../runs/entity/item.entity';
import type { ItemKind } from '../../runs/runs.types';
import { unansweredRequests } from './unanswerable';

/** A stored transcript row — only the fields this reader touches. */
function row(
  kind: ItemKind,
  payload: string,
  nodeId: string | null = null,
): Item {
  return { kind, payload, nodeId } as Item;
}

const request = (id: string, toolName = 'Bash'): Item =>
  row('approval_request', JSON.stringify({ id, toolName }));

describe('unansweredRequests', () => {
  it('returns the requests nothing ever settled, with their owner node', () => {
    const found = unansweredRequests([
      request('a'),
      request('b'),
      row('approval_verdict', JSON.stringify({ id: 'a', allow: true })),
      row('approval_request', JSON.stringify({ id: 'c' }), 'node-1'),
    ]);
    expect(found).toEqual([
      { nodeId: null, payload: { id: 'b', toolName: 'Bash' } },
      // No toolName in the payload: named generically rather than dropped, so
      // the card still closes.
      { nodeId: 'node-1', payload: { id: 'c', toolName: 'tool' } },
    ]);
  });

  it('treats an already-swept request as settled', () => {
    expect(
      unansweredRequests([
        request('a'),
        row('unanswerable', JSON.stringify({ id: 'a', toolName: 'Bash' })),
      ]),
    ).toEqual([]);
  });

  it('REOPENS a reused id — the last event for it wins', () => {
    // A CLI that restarts its request numbering on --resume produces this
    // within one run's transcript. Accumulating "closed" ids across the whole
    // scan would filter the second, still-open request out and leave its card
    // live forever.
    expect(
      unansweredRequests([
        request('1', 'Read'),
        row('approval_verdict', JSON.stringify({ id: '1', allow: true })),
        request('1', 'Write'),
      ]),
    ).toEqual([{ nodeId: null, payload: { id: '1', toolName: 'Write' } }]);
  });

  it('survives a payload that is not JSON, or not an object', () => {
    // Entering the defensive branches deliberately: this runs inside boot
    // reconcile, where a throw would abort the sweep for the WHOLE run and
    // leave every other card live.
    expect(
      unansweredRequests([
        row('approval_request', 'not json at all'),
        row('approval_request', '"a bare string"'),
        row('approval_request', 'null'),
        request('ok'),
      ]),
    ).toEqual([{ nodeId: null, payload: { id: 'ok', toolName: 'Bash' } }]);
  });

  it('ignores a request whose id is not a string', () => {
    expect(
      unansweredRequests([
        row('approval_request', JSON.stringify({ id: 42, toolName: 'Bash' })),
        row('approval_request', JSON.stringify({ toolName: 'Bash' })),
      ]),
    ).toEqual([]);
  });

  it('names the tool generically when toolName is present but not a string', () => {
    expect(
      unansweredRequests([
        row('approval_request', JSON.stringify({ id: 'a', toolName: 7 })),
      ]),
    ).toEqual([{ nodeId: null, payload: { id: 'a', toolName: 'tool' } }]);
  });
});
