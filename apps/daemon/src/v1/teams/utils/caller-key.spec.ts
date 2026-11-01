import { describe, expect, it } from 'vitest';

import { callerKey, callerNodeOf } from './caller-key';

describe('callerKey', () => {
  it('keys a node’s own conversation as the bare node id', () => {
    expect(callerKey('engineer', null)).toBe('engineer');
    expect(callerNodeOf('engineer')).toBe('engineer');
  });

  it('reads the node back out of a conversation key', () => {
    expect(callerNodeOf(callerKey('engineer', 'call-3'))).toBe('engineer');
  });

  it('reads a node id holding a control character back whole', () => {
    // The node schema refuses a NUL in an id and nothing else, so any other
    // control character is a legal id — and a separator that is one would read
    // `a<US>b` speaking in `call-1` as node `a`.
    const id = 'review\u001fteam';

    expect(callerNodeOf(callerKey(id, 'call-1'))).toBe(id);
  });
});
