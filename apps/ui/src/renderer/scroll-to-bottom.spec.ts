import { describe, expect, it, vi } from 'vitest';

import { scrollToBottom } from './scroll-to-bottom';

describe('scrollToBottom', () => {
  it('drives the box to its own full scroll height', () => {
    const scrollTo = vi.fn();
    scrollToBottom({ scrollHeight: 4000, scrollTo }, 'auto');
    expect(scrollTo).toHaveBeenCalledWith({ top: 4000, behavior: 'auto' });
  });

  it('passes the behaviour through', () => {
    const scrollTo = vi.fn();
    scrollToBottom({ scrollHeight: 120, scrollTo }, 'smooth');
    expect(scrollTo).toHaveBeenCalledWith({ top: 120, behavior: 'smooth' });
  });
});
