import { describe, expect, it, vi } from 'vitest';

import { createComposerText } from './composer-text';

describe('createComposerText', () => {
  it('takes a value or an updater, applied at once, as setState takes one', () => {
    const text = createComposerText();
    text.set('draft');
    text.set((current) => `${current} more`);

    expect(text.get()).toBe('draft more');
  });

  it('tells subscribers of a change, not of a write that changed nothing', () => {
    const text = createComposerText('same');
    const listener = vi.fn();
    const unsubscribe = text.subscribe(listener);

    text.set('same');
    expect(listener).not.toHaveBeenCalled();
    text.set('other');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    text.set('again');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
