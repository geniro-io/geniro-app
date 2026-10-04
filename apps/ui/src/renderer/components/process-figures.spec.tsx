// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import {
  formatMemory,
  formatShare,
  ProcessFigureCells,
  ShareStack,
} from './process-figures';

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

describe('formatShare', () => {
  it('says <1% for a part too small to round to one, never 0%', () => {
    expect(formatShare(0.004)).toBe('<1%');
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(0.336)).toBe('34%');
  });
});

describe('ShareStack', () => {
  const segment = (key: string, value: number) => ({
    key,
    label: key,
    value,
    colorClass: 'bg-group-blue',
  });

  it('divides one bar by each part’s share of the whole, and says so', () => {
    const el = mount(
      <ShareStack
        label="Memory"
        segments={[segment('a', 300), segment('b', 100), segment('c', 0)]}
      />,
    );
    const widths = [
      ...el.querySelectorAll<HTMLElement>('[data-slot="share-segment"]'),
    ].map((part) => part.style.width);
    // An empty part draws nothing rather than a sliver it does not have.
    expect(widths).toEqual(['75%', '25%']);
    expect(
      el.querySelector('[data-slot="share-stack"]')?.getAttribute('aria-label'),
    ).toBe('Memory: a 75%, b 25%, c 0%');
  });

  it('draws an empty track for a whole of nothing', () => {
    const el = mount(<ShareStack label="CPU" segments={[segment('a', 0)]} />);
    expect(el.querySelectorAll('[data-slot="share-segment"]')).toHaveLength(0);
  });
});
