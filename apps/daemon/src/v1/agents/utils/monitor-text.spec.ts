import { describe, expect, it } from 'vitest';

import { monitorMessageText, promptNamingRunning } from './monitor-text';

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

describe('promptNamingRunning', () => {
  it('leaves the prompt alone when nothing runs', () => {
    expect(promptNamingRunning('output', [])).toBe('output');
  });

  it('names each running monitor after the output and how to stop it', () => {
    const text = promptNamingRunning('output', [
      { id: 'm1', description: 'seed run' },
      { id: 'm2', description: 'CI' },
    ]);
    expect(text.startsWith('output\n\n[geniro] Still running:')).toBe(true);
    expect(text).toContain('m1 (seed run), m2 (CI)');
    expect(text).toContain('stop_monitor');
  });
});
