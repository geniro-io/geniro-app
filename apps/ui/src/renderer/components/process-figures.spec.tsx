// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { formatMemory, ProcessFigureCells, ShareBar } from './process-figures';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: React.ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('formatMemory', () => {
  it.each([
    [512 * 1024, '512 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [3 * 1024 * 1024 * 1024, '3.00 GB'],
  ])('%d bytes reads %s', (bytes, text) => {
    expect(formatMemory(bytes)).toBe(text);
  });
});

describe('ProcessFigureCells', () => {
  it('draws a busy process’s CPU in the warning tone and an idle one muted', () => {
    const busy = mount(<ProcessFigureCells cpuPercent={80} rssBytes={0} />);
    expect(
      busy.querySelector('[data-slot="process-cpu"]')?.className,
    ).toContain('text-warning');
    act(() => root?.render(<ProcessFigureCells cpuPercent={0} rssBytes={0} />));
    expect(
      busy.querySelector('[data-slot="process-cpu"]')?.className,
    ).toContain('text-muted-foreground');
  });
});

describe('ShareBar', () => {
  function width(el: HTMLElement): string {
    return (el.querySelector('[data-slot="share-bar"] > div') as HTMLElement)
      .style.width;
  }

  it('fills to the share it is given, clamped to the track', () => {
    expect(width(mount(<ShareBar fraction={0.4} label="x" />))).toBe('40%');
    act(() => root?.render(<ShareBar fraction={3} label="x" />));
    expect(width(host as HTMLDivElement)).toBe('100%');
  });

  it('keeps a sliver for a share too small to see, and nothing for none', () => {
    expect(width(mount(<ShareBar fraction={0.001} label="x" />))).toBe('2%');
    act(() => root?.render(<ShareBar fraction={0} label="x" />));
    expect(width(host as HTMLDivElement)).toBe('0%');
  });
});
