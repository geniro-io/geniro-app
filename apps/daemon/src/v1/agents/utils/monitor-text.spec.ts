import { describe, expect, it } from 'vitest';

import { monitorMessageText } from './monitor-text';

const message = (kind: 'stopped' | 'timeout') => ({
  id: 'm2',
  description: 'long wait',
  batch: { lines: [], omitted: 0 },
  end: { kind },
});

describe('monitorMessageText', () => {
  it('tells the agent the user stopped its monitor from the process panel', () => {
    const text = monitorMessageText(message('stopped'));
    expect(text).toContain(
      '<message from="long wait · monitor · stopped" monitor="m2">',
    );
    expect(text).toContain('The user stopped it from the process panel.');
  });

  it('names no one for an end that is not a stop', () => {
    expect(monitorMessageText(message('timeout'))).not.toContain('The user');
  });
});
